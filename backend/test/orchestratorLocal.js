const { ethers } = require('ethers');

function checkThreshold({ userBalance, totalDeposit, thresholdPercent = 10 }) {
  const userWei  = BigInt(userBalance);
  const totalWei = BigInt(totalDeposit);
  const pct = totalWei === 0n ? 0 : Number(userWei * 100n / totalWei);
  return {
    warning: pct <= thresholdPercent,
    remainingPercent: pct,
    userBalanceUsdc: ethers.formatUnits(userWei, 6),
  };
}

module.exports = { checkThreshold };
