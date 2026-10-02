const { expect } = require("chai");
const { ethers } = require("hardhat");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const { execFileSync } = require("child_process");
const path = require("path");

const OP_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const USER_KEY = "0x0123456789012345678901234567890123456789012345678901234567890123";

async function fixture(opts = {}) {
  const [operator, user] = await ethers.getSigners();
  const USDC = await ethers.getContractFactory("MockUSDC");
  const usdc = await USDC.deploy();
  const Escrow = await ethers.getContractFactory("SmartCityEscrow");
  const escrow = await Escrow.deploy(await usdc.getAddress(), operator.address);
  const sessionId = opts.sessionId ?? "db-session-001";
  const escrowId = ethers.keccak256(ethers.toUtf8Bytes(sessionId));
  const deposit = ethers.parseUnits(opts.deposit ?? "3.0", 6);
  const fare = ethers.parseUnits(opts.fare ?? "1.25", 6);
  const proof = makeProof({
    escrowAddress: await escrow.getAddress(),
    escrowId,
    userAddress: user.address,
    deposit: deposit.toString(),
    fare: fare.toString(),
    final: opts.final,
  });
  await usdc.mint(user.address, deposit);
  await usdc.mint(operator.address, deposit);
  await usdc.connect(user).approve(await escrow.getAddress(), deposit);
  await usdc.connect(operator).approve(await escrow.getAddress(), deposit);
  const now = (await ethers.provider.getBlock("latest")).timestamp;
  await escrow.connect(user).userDeposit(escrowId, operator.address, deposit, now + 30, proof.channelId);
  await escrow.operatorDeposit(escrowId, deposit);
  await ethers.provider.send("evm_increaseTime", [31]);
  await ethers.provider.send("evm_mine");
  return { escrow, usdc, operator, user, escrowId, deposit, fare, proof };
}

function makeProof(input) {
  const go = process.env.GO_BINARY || "go";
  const cwd = path.join(__dirname, "..", "..", "go-perun-node");
  const payload = JSON.stringify({
    operatorKey: OP_KEY,
    userKey: USER_KEY,
    chainId: "31337",
    nonce: "7",
    version: 3,
    ...input,
  });
  return JSON.parse(execFileSync(go, ["run", "./cmd/perun-proof-fixture"], { cwd, input: payload }).toString());
}

describe("SmartCityEscrow state-bound settlement", function () {
  this.timeout(120000);

  it("extracts fare only from a verified final Perun state", async function () {
    const { escrow, operator, user, escrowId, fare, proof } = await fixture();
    expect(await escrow.verifiedFare(escrowId, proof.paramsABI, proof.stateABI, proof.signatures)).to.equal(fare);
    await expect(escrow.settleAndRelease(escrowId, proof.paramsABI, proof.stateABI, proof.signatures))
      .to.emit(escrow, "SettlementReserved")
      .withArgs(escrowId, operator.address, fare, user.address, ethers.parseUnits("1.75", 6), ethers.parseUnits("3.0", 6), anyValue);
  });

  it("rejects tampered appData fare and non-final states", async function () {
    const { escrow, usdc, operator, escrowId, proof, deposit, user } = await fixture();
    const escrowAddress = await escrow.getAddress();
    const balancesBefore = {
      escrow: await usdc.balanceOf(escrowAddress),
      operator: await usdc.balanceOf(operator.address),
      user: await usdc.balanceOf(user.address),
    };
    const tampered = makeProof({
      escrowAddress,
      escrowId,
      userAddress: user.address,
      deposit: deposit.toString(),
      fare: ethers.parseUnits("2.50", 6).toString(),
    });
    await expect(escrow.verifiedFare(escrowId, tampered.paramsABI, proof.stateABI, tampered.signatures))
      .to.be.revertedWithCustomError(escrow, "InvalidPerunProof");
    await expect(escrow.settleAndRelease(escrowId, tampered.paramsABI, proof.stateABI, tampered.signatures))
      .to.be.revertedWithCustomError(escrow, "InvalidPerunProof");

    const nonFinal = makeProof({
      escrowAddress,
      escrowId,
      userAddress: user.address,
      deposit: deposit.toString(),
      fare: ethers.parseUnits("1.00", 6).toString(),
      final: false,
    });
    await expect(escrow.verifiedFare(escrowId, nonFinal.paramsABI, nonFinal.stateABI, nonFinal.signatures))
      .to.be.revertedWithCustomError(escrow, "InvalidPerunProof");
    await expect(escrow.settleAndRelease(escrowId, nonFinal.paramsABI, nonFinal.stateABI, nonFinal.signatures))
      .to.be.revertedWithCustomError(escrow, "InvalidPerunProof");

    expect(await usdc.balanceOf(escrowAddress)).to.equal(balancesBefore.escrow);
    expect(await usdc.balanceOf(operator.address)).to.equal(balancesBefore.operator);
    expect(await usdc.balanceOf(user.address)).to.equal(balancesBefore.user);
    expect((await escrow.getEscrowStatus(escrowId))[0]).to.equal(2);
  });

  it("rejects a final state signed for a different channel and leaves USDC untouched", async function () {
    const { escrow, usdc, operator, user, escrowId, proof, deposit } = await fixture();
    const otherChannel = makeProof({
      escrowAddress: await escrow.getAddress(), escrowId,
      userAddress: user.address, deposit: deposit.toString(),
      fare: ethers.parseUnits("1.25", 6).toString(), nonce: "8",
    });
    expect(otherChannel.channelId).not.to.equal(proof.channelId);
    const before = await usdc.balanceOf(await escrow.getAddress());
    await expect(escrow.connect(operator).settleAndRelease(
      escrowId, otherChannel.paramsABI, otherChannel.stateABI, otherChannel.signatures,
    )).to.be.revertedWithCustomError(escrow, "InvalidPerunProof");
    expect(await usdc.balanceOf(await escrow.getAddress())).to.equal(before);
    expect((await escrow.getEscrowStatus(escrowId))[0]).to.equal(2);
  });

  it("characterizes the stale-final-state gap when a newer signed final state exists only off-chain", async function () {
    const { escrow, usdc, user, escrowId, proof, deposit } = await fixture();
    const earlierNonFinal = makeProof({
      escrowAddress: await escrow.getAddress(), escrowId,
      userAddress: user.address, deposit: deposit.toString(),
      fare: ethers.parseUnits("1.00", 6).toString(), version: 2, final: false,
    });
    const newer = makeProof({
      escrowAddress: await escrow.getAddress(), escrowId,
      userAddress: user.address, deposit: deposit.toString(),
      fare: ethers.parseUnits("2.00", 6).toString(), version: 4,
    });
    expect(newer.channelId).to.equal(proof.channelId);
    expect(newer.stateHash).not.to.equal(proof.stateHash);
    await expect(escrow.settleAndRelease(
      escrowId, earlierNonFinal.paramsABI, earlierNonFinal.stateABI, earlierNonFinal.signatures,
    )).to.be.revertedWithCustomError(escrow, "InvalidPerunProof");
    // Version 4 exists solely off-chain; the escrow cannot compare it with
    // the submitted, validly signed version 3 proof. Honest Go-Perun cannot
    // advance after finalization, so this models signer equivocation.
    expect(await escrow.verifiedFare(escrowId, newer.paramsABI, newer.stateABI, newer.signatures))
      .to.equal(ethers.parseUnits("2.00", 6));
    await escrow.settleAndRelease(escrowId, proof.paramsABI, proof.stateABI, proof.signatures);
    expect((await escrow.getEscrowStatus(escrowId))[3]).to.equal(ethers.parseUnits("1.25", 6));
    expect(await usdc.balanceOf(await escrow.getAddress())).to.equal(deposit * 2n);
    await expect(escrow.settleAndRelease(escrowId, newer.paramsABI, newer.stateABI, newer.signatures))
      .to.be.revertedWithCustomError(escrow, "InvalidState");
  });

  it("keeps funds reserved through the dispute window, then claims", async function () {
    const { escrow, usdc, operator, user, escrowId, proof, fare, deposit } = await fixture();
    await escrow.settleAndRelease(escrowId, proof.paramsABI, proof.stateABI, proof.signatures);
    const pendingClaim = await escrow.getSettlementClaim(escrowId);
    expect(pendingClaim[1]).to.equal(fare);
    expect(pendingClaim[2]).to.equal(deposit - fare);
    expect(pendingClaim[3]).to.equal(deposit);
    expect(pendingClaim[4]).to.equal(false);
    const escrowBefore = await usdc.balanceOf(await escrow.getAddress());
    await expect(escrow.claimSettlement(escrowId)).to.be.revertedWithCustomError(escrow, "ClaimPeriodNotEnded");
    expect(await usdc.balanceOf(await escrow.getAddress())).to.equal(escrowBefore);

    await ethers.provider.send("evm_increaseTime", [4 * 60 + 1]);
    await ethers.provider.send("evm_mine");

    const opBefore = await usdc.balanceOf(operator.address);
    const userBefore = await usdc.balanceOf(user.address);
    await escrow.claimSettlement(escrowId);
    expect(await usdc.balanceOf(operator.address)).to.equal(opBefore + fare + deposit);
    expect(await usdc.balanceOf(user.address)).to.equal(userBefore + (deposit - fare));
    const paidClaim = await escrow.getSettlementClaim(escrowId);
    expect(paidClaim[1]).to.equal(0);
    expect(paidClaim[2]).to.equal(0);
    expect(paidClaim[3]).to.equal(0);
    expect(paidClaim[4]).to.equal(true);
    await expect(escrow.claimSettlement(escrowId))
      .to.be.revertedWithCustomError(escrow, "SettlementAlreadyClaimed");
  });

  for (const refundFare of ["0", "1.25"]) {
    it(`preserves reserved-settlement refund accounting with ${refundFare} USDC fare`, async function () {
      const { escrow, usdc, operator, user, escrowId, proof, deposit } = await fixture();
      const farePaid = ethers.parseUnits(refundFare, 6);
      await escrow.settleAndRelease(escrowId, proof.paramsABI, proof.stateABI, proof.signatures);
      await escrow.registerRefundIssue(escrowId, 1, "device fault", false);
      await expect(escrow.refundToBuyer(escrowId, ethers.parseUnits("1.26", 6)))
        .to.be.revertedWithCustomError(escrow, "FareExceedsUserDeposit");
      await escrow.refundToBuyer(escrowId, farePaid);
      expect(await usdc.balanceOf(user.address)).to.equal(deposit - farePaid);
      expect(await usdc.balanceOf(operator.address)).to.equal(deposit + farePaid);
      expect(await usdc.balanceOf(await escrow.getAddress())).to.equal(0);
      const closedClaim = await escrow.getSettlementClaim(escrowId);
      expect(closedClaim[1]).to.equal(0);
      expect(closedClaim[2]).to.equal(0);
      expect(closedClaim[3]).to.equal(0);
      expect(closedClaim[4]).to.equal(true);
    });
  }

  it("returns the original deposits on timeout without a settlement reservation", async function () {
    const { escrow, usdc, operator, user, escrowId, deposit } = await fixture();
    const beforeClaim = await escrow.getSettlementClaim(escrowId);
    expect(beforeClaim[1]).to.equal(0);
    expect(beforeClaim[2]).to.equal(0);
    expect(beforeClaim[3]).to.equal(0);
    await ethers.provider.send("evm_increaseTime", [60 * 60]);
    await ethers.provider.send("evm_mine");
    await escrow.forceRefund(escrowId);
    expect(await usdc.balanceOf(user.address)).to.equal(deposit);
    expect(await usdc.balanceOf(operator.address)).to.equal(deposit);
    expect(await usdc.balanceOf(await escrow.getAddress())).to.equal(0);
    expect((await escrow.getSettlementClaim(escrowId))[4]).to.equal(true);
  });

  it("preserves emergency cancellation after settlement reservation", async function () {
    const { escrow, usdc, operator, user, escrowId, proof, deposit } = await fixture();
    await escrow.settleAndRelease(escrowId, proof.paramsABI, proof.stateABI, proof.signatures);
    await escrow.emergencyCancel(escrowId);
    expect(await usdc.balanceOf(user.address)).to.equal(deposit);
    expect(await usdc.balanceOf(operator.address)).to.equal(deposit);
    expect(await usdc.balanceOf(await escrow.getAddress())).to.equal(0);
    const claim = await escrow.getSettlementClaim(escrowId);
    expect(claim[1]).to.equal(0);
    expect(claim[2]).to.equal(0);
    expect(claim[3]).to.equal(0);
    expect(claim[4]).to.equal(true);
  });

  it("rejects a deadline that cannot fit the packed timestamp", async function () {
    const { escrow, operator, user } = await fixture();
    await expect(escrow.connect(user).userDeposit(
      ethers.keccak256(ethers.toUtf8Bytes("oversized-deadline")),
      operator.address,
      ethers.parseUnits("1", 6),
      1n << 64n,
      ethers.keccak256(ethers.toUtf8Bytes("unused-channel")),
    )).to.be.revertedWithCustomError(escrow, "InvalidHoldDeadline");
  });

  it("does not allow arbitrary refund fare before a Perun reservation", async function () {
    const { escrow, escrowId } = await fixture();
    await escrow.registerRefundIssue(escrowId, 0, "unlock failure", false);
    await expect(escrow.refundToBuyer(escrowId, 1)).to.be.revertedWithCustomError(escrow, "FareExceedsUserDeposit");
  });

  it("rejects refund without an issue and unauthorized issue registration", async function () {
    const { escrow, usdc, operator, user, escrowId, deposit } = await fixture();
    const escrowAddress = await escrow.getAddress();
    const before = await usdc.balanceOf(escrowAddress);
    await expect(escrow.connect(user).registerRefundIssue(escrowId, 0, "fabricated", false))
      .to.be.reverted;
    await expect(escrow.connect(operator).refundToBuyer(escrowId, 0))
      .to.be.revertedWithCustomError(escrow, "InvalidState");
    await expect(escrow.connect(user).forceRefund(escrowId))
      .to.be.revertedWithCustomError(escrow, "DeadlineNotPassed");
    expect(await usdc.balanceOf(escrowAddress)).to.equal(before);
    expect((await escrow.getEscrowStatus(escrowId))[0]).to.equal(2);

    // A permitted operator can register an issue without on-chain device evidence.
    await escrow.connect(operator).registerRefundIssue(escrowId, 0, "operator asserted", false);
    await escrow.connect(operator).refundToBuyer(escrowId, 0);
    expect(await usdc.balanceOf(user.address)).to.equal(deposit);
  });
});
