const hre = require("hardhat");

async function main() {
  console.log("🚀 Monad FL Coordinator Deployment Başlıyor...\n");

  // Deployment parametreleri
  const MIN_STAKE = hre.ethers.parseEther("0.1");        // 0.1 MON minimum stake
  const ROUND_DURATION = 3600;                             // 1 saat per round
  const MIN_UPDATES_PER_ROUND = 3;                         // Minimum 3 güncelleme
  const SLASH_PERCENTAGE = 30;                             // %30 ceza
  const REWARD_PER_UPDATE = hre.ethers.parseEther("0.01"); // 0.01 MON per güncelleme

  console.log("📋 Deployment Parametreleri:");
  console.log(`   Min Stake:          ${hre.ethers.formatEther(MIN_STAKE)} MON`);
  console.log(`   Tur Süresi:         ${ROUND_DURATION}s (${ROUND_DURATION / 60} dk)`);
  console.log(`   Min Güncelleme:     ${MIN_UPDATES_PER_ROUND}`);
  console.log(`   Ceza Yüzdesi:       %${SLASH_PERCENTAGE}`);
  console.log(`   Güncelleme Ödülü:   ${hre.ethers.formatEther(REWARD_PER_UPDATE)} MON`);
  console.log("");

  // Deployer bilgisi
  const [deployer] = await hre.ethers.getSigners();
  console.log(`👤 Deployer: ${deployer.address}`);

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log(`💰 Bakiye:   ${hre.ethers.formatEther(balance)} MON\n`);

  // Kontratı deploy et
  console.log("⏳ Kontrat derleniyor ve deploy ediliyor...");

  const FLCoordinator = await hre.ethers.getContractFactory("FLCoordinator");
  const coordinator = await FLCoordinator.deploy(
    MIN_STAKE,
    ROUND_DURATION,
    MIN_UPDATES_PER_ROUND,
    SLASH_PERCENTAGE,
    REWARD_PER_UPDATE
  );

  await coordinator.waitForDeployment();
  const address = await coordinator.getAddress();

  console.log(`\n✅ FLCoordinator deploy edildi!`);
  console.log(`📍 Kontrat Adresi: ${address}`);
  console.log(`🔗 Explorer: https://testnet.monadexplorer.com/address/${address}\n`);

  // İlk ödül havuzunu fonla (opsiyonel)
  const INITIAL_FUND = hre.ethers.parseEther("1.0");
  if (balance > INITIAL_FUND + hre.ethers.parseEther("0.1")) {
    console.log(`💎 Ödül havuzu fonlanıyor: ${hre.ethers.formatEther(INITIAL_FUND)} MON...`);
    const tx = await coordinator.fundRewardPool({ value: INITIAL_FUND });
    await tx.wait();
    console.log("✅ Ödül havuzu fonlandı!\n");
  }

  // Deployment özeti
  console.log("═══════════════════════════════════════════");
  console.log("        DEPLOYMENT ÖZETİ");
  console.log("═══════════════════════════════════════════");
  console.log(`  Ağ:              Monad Testnet (10143)`);
  console.log(`  Kontrat:         ${address}`);
  console.log(`  Owner:           ${deployer.address}`);
  console.log(`  Aggregator:      ${deployer.address}`);
  console.log("═══════════════════════════════════════════\n");

  // Verify komutu
  console.log("📝 Verify komutu:");
  console.log(`npx hardhat verify --network monadTestnet ${address} \\`);
  console.log(`  "${MIN_STAKE}" "${ROUND_DURATION}" "${MIN_UPDATES_PER_ROUND}" "${SLASH_PERCENTAGE}" "${REWARD_PER_UPDATE}"\n`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Deployment hatası:", error);
    process.exit(1);
  });
