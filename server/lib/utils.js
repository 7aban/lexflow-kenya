const genId = prefix => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const today = () => new Date().toISOString().slice(0, 10);
const addDays = days => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
const invoiceNumber = () => `INV-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}`;
const money = amount => `KSh ${Number(amount || 0).toLocaleString('en-KE')}`;

module.exports = {
  genId,
  today,
  addDays,
  invoiceNumber,
  money,
};
