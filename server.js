const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const TRC20_ADDR = 'TY27SXz44BdZbx8FkY82RRSyJYc6fYA9sh';
const BEP20_ADDR = '0x7279cCc505ede20330Fe0a70232Ec8Dba23550D0';
const USDT_TRC20_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const USDT_BEP20_CONTRACT = '0x55d398326f99059fF775485246999027B3197955';
const TRON_API_KEY = process.env.TRON_API_KEY || '';
const BSC_API_KEY = process.env.BSC_API_KEY || '';

const orders = {};

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
  if (chainType === 2 || chainType === '2' || chainType === 'BEP20') return await checkBEP20(expectedAmount);
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
    usdtNetwork: chainType === 2 ? 'BEP20' : 'TRC20',
    amount: Number(amount), status: 1,
    createTime: new Date().toISOString(),
    createdAt: new Date().toISOString(), currency: 'USDT'
  };
  orders[orderId] = order;
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
        console.log(`[APPROVED] ${buyId} | ${result.explorerUrl}`);
      }
    } catch (e) {}
  }
  res.json({ code: 1000, data: order });
});

app.get('/app/payment/order/summary', (req, res) => {
  res.json({ code: 1000, data: { usdtRechargeRate: 95, usdtCashbackRate: 0, balance: 0, reward: 0, pending: 0 } });
});

// Health check
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
        console.log(`[AUTO-APPROVED] ${order.orderId}`);
      }
    } catch (e) {}
  }
}, 30000);

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`   TRC20: ${TRC20_ADDR}`);
  console.log(`   BEP20: ${BEP20_ADDR}`);
});