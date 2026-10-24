const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const app = express();
app.use(express.json());

const TRC20_ADDR = 'TY27SXz44BdZbx8FkY82RRSyJYc6fYA9sh';
const BEP20_ADDR = '0x7279cCc505ede20330Fe0a70232Ec8Dba23550D0';
const USDT_TRC20_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const USDT_BEP20_CONTRACT = '0x55d398326f99059fF775485246999027B3197955';
const TRON_API_KEY = process.env.TRON_API_KEY || '';
const BSC_API_KEY  = process.env.BSC_API_KEY  || '';

const DATA_DIR = process.env.DATA_DIR || '';
const ORDERS_FILE = DATA_DIR ? path.join(DATA_DIR, 'orders.json') : '';
let orders = Object.create(null);
if (DATA_DIR) fs.mkdirSync(DATA_DIR, { recursive: true });
if (ORDERS_FILE && fs.existsSync(ORDERS_FILE)) {
  const savedOrders = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
  if (!savedOrders || typeof savedOrders !== 'object' || Array.isArray(savedOrders)) {
    throw new Error(`Invalid persisted orders file: ${ORDERS_FILE}`);
  }
  orders = Object.assign(Object.create(null), savedOrders);
}
if (!DATA_DIR) {
  console.warn('[ORDER STORAGE] DATA_DIR is unset; orders are memory-only and will be lost on restart.');
}

function persistOrders() {
  if (!ORDERS_FILE) return;
  const tempFile = `${ORDERS_FILE}.tmp`;
  try {
    fs.writeFileSync(tempFile, JSON.stringify(orders), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempFile, ORDERS_FILE);
  } catch (error) {
    error.code = 'ORDER_STORAGE_WRITE_FAILED';
    throw error;
  }
}

async function checkTRC20(expectedAmount) {
  try {
    const headers = {};
    if (TRON_API_KEY) headers['TRON-PRO-API-KEY'] = TRON_API_KEY;
    const res = await axios.get(
      `https://api.trongrid.io/v1/accounts/${TRC20_ADDR}/transactions/trc20`,
      {
        params: {
          only_to: true,
          contract_address: USDT_TRC20_CONTRACT,
          limit: 50,
          min_timestamp: Date.now() - 24 * 60 * 60 * 1000
        },
        headers, timeout: 10000
      }
    );
    const txs = res.data.data || [];
    for (const tx of txs) {
      const amount = Number(tx.value) / 1e6;
      const confirmed = tx.ret?.[0]?.contractRet === 'SUCCESS';
      if (tx.to === TRC20_ADDR && confirmed && Math.abs(amount - expectedAmount) < 0.01) {
        return {
          matched: true, txId: tx.transaction_id, amount, network: 'TRC20',
          explorerUrl: `https://tronscan.org/#/transaction/${tx.transaction_id}`
        };
      }
    }
    return { matched: false, network: 'TRC20' };
  } catch (e) {
    return { matched: false, network: 'TRC20', error: e.message };
  }
}

async function checkBEP20(expectedAmount) {
  try {
    const res = await axios.get('https://api.bscscan.com/api', {
      params: {
        module: 'account', action: 'tokentx',
        contractaddress: USDT_BEP20_CONTRACT, address: BEP20_ADDR,
        page: 1, offset: 50, sort: 'desc',
        apikey: BSC_API_KEY || 'YourApiKeyToken'
      }, timeout: 10000
    });
    if (res.data.status !== '1') return { matched: false, network: 'BEP20' };
    const txs = res.data.result || [];
    for (const tx of txs) {
      const amount = Number(tx.value) / 1e18;
      const confirmed = Number(tx.confirmations) >= 1;
      if (tx.to.toLowerCase() === BEP20_ADDR.toLowerCase() && confirmed && Math.abs(amount - expectedAmount) < 0.01) {
        return {
          matched: true, txId: tx.hash, amount, network: 'BEP20',
          explorerUrl: `https://bscscan.com/tx/${tx.hash}`
        };
      }
    }
    return { matched: false, network: 'BEP20' };
  } catch (e) {
    return { matched: false, network: 'BEP20', error: e.message };
  }
}

async function verifyDeposit(chainType, expectedAmount) {
  if (chainType === 2 || chainType === '2' || chainType === 'BEP20')
    return await checkBEP20(expectedAmount);
  return await checkTRC20(expectedAmount);
}

app.post('/app/payment/order/createUsdt', (req, res) => {
  const { amount, type } = req.body;
  if (!amount || amount <= 0) return res.json({ code: 400, msg: 'Invalid amount' });
  const chainType = Number(type) === 2 ? 2 : 1;
  const orderId = 'U' + Date.now() + Math.floor(Math.random() * 10000);
  const address = chainType === 2 ? BEP20_ADDR : TRC20_ADDR;
  const order = {
    id: orderId, orderId, orderNo: orderId, buyId: orderId, address,
    type: chainType, chainType,
    usdtNetwork: chainType === 2 ? 'BEP20' : 'TRC20',
    amount: Number(amount), status: 1,
    createTime: new Date().toISOString(),
    createdAt: new Date().toISOString(), currency: 'USDT'
  };
  orders[orderId] = order;
  try {
    persistOrders();
  } catch (error) {
    delete orders[orderId];
    console.error(`[ORDER STORAGE ERROR] ${orderId}: ${error.message}`);
    return res.status(500).json({ code: 500, msg: 'Could not persist order; try again' });
  }
  console.log(`[CREATE] ${orderId} | ${amount} USDT | ${order.usdtNetwork}`);
  res.json({ code: 1000, data: order });
});

app.get('/app/payment/order/usdtInfo', async (req, res) => {
  const { buyId } = req.query;
  const order = orders[buyId];
  if (!order) return res.json({ code: 404, msg: 'Order not found' });
  if (order.status === 1) {
    try {
      const chainType = order.usdtNetwork === 'BEP20' ? 2 : 1;
      const result = await verifyDeposit(chainType, order.amount);
      if (result.matched) {
        order.status = 3;
        order.txId = result.txId;
        order.explorerUrl = result.explorerUrl;
        order.successTime = new Date().toISOString();
        try {
          persistOrders();
        } catch (error) {
          order.status = 1;
          delete order.txId;
          delete order.explorerUrl;
          delete order.successTime;
          console.error(`[ORDER STORAGE ERROR] ${buyId}: ${error.message}`);
          return res.status(500).json({ code: 500, msg: 'Could not persist order status' });
        }
        console.log(`[APPROVED] ${buyId} | ${result.explorerUrl}`);
      }
    } catch (e) {
      console.error(`[VERIFY ERROR] ${buyId}: ${e.message}`);
      if (e.code === 'ORDER_STORAGE_WRITE_FAILED') {
        return res.status(500).json({ code: 500, msg: 'Could not persist order status' });
      }
    }
  }
  res.json({ code: 1000, data: order });
});

app.get('/app/payment/order/summary', (req, res) => {
  res.json({ code: 1000, data: { usdtRechargeRate: 95, usdtCashbackRate: 0, balance: 0, reward: 0, pending: 0 } });
});

app.get('/', (req, res) => res.json({ status: 'ok', server: 'usdt-verify' }));

setInterval(async () => {
  const pending = Object.values(orders).filter(o => o.status === 1);
  for (const order of pending) {
    try {
      const chainType = order.usdtNetwork === 'BEP20' ? 2 : 1;
      const result = await verifyDeposit(chainType, order.amount);
      if (result.matched) {
        order.status = 3;
        order.txId = result.txId;
        order.explorerUrl = result.explorerUrl;
        order.successTime = new Date().toISOString();
        try {
          persistOrders();
        } catch (e) {
          order.status = 1;
          delete order.txId;
          delete order.explorerUrl;
          delete order.successTime;
          console.error(`[ORDER STORAGE ERROR] ${order.orderId}: ${e.message}`);
        }
        console.log(`[AUTO-APPROVED] ${order.orderId}`);
      }
    } catch (e) {
      console.error(`[AUTO-VERIFY ERROR] ${order.orderId}: ${e.message}`);
    }
  }
}, 30000);

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`   TRC20: ${TRC20_ADDR}`);
  console.log(`   BEP20: ${BEP20_ADDR}`);
});
