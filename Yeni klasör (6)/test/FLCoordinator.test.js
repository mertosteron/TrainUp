const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("FLCoordinator", function () {
  let coordinator;
  let owner, aggregator, worker1, worker2, worker3, malicious;

  const MIN_STAKE = ethers.parseEther("0.1");
  const ROUND_DURATION = 3600;
  const MIN_UPDATES = 2;
  const SLASH_PERCENTAGE = 30;
  const REWARD_PER_UPDATE = ethers.parseEther("0.01");

  beforeEach(async function () {
    [owner, aggregator, worker1, worker2, worker3, malicious] = await ethers.getSigners();

    const FLCoordinator = await ethers.getContractFactory("FLCoordinator");
    coordinator = await FLCoordinator.deploy(
      MIN_STAKE,
      ROUND_DURATION,
      MIN_UPDATES,
      SLASH_PERCENTAGE,
      REWARD_PER_UPDATE
    );
    await coordinator.waitForDeployment();

    // Aggregator'ü ayarla
    await coordinator.setAggregator(aggregator.address);
  });

  // =========================================================================
  //                      KATILIMCI YÖNETİMİ
  // =========================================================================

  describe("Katılımcı Yönetimi", function () {
    it("Yeterli stake ile kayıt olabilmeli", async function () {
      await coordinator.connect(worker1).registerParticipant({ value: MIN_STAKE });

      const p = await coordinator.getParticipant(worker1.address);
      expect(p.stake).to.equal(MIN_STAKE);
      expect(p.reputation).to.equal(500);
      expect(p.isActive).to.be.true;
      expect(p.isSlashed).to.be.false;
    });

    it("Yetersiz stake ile kayıt olamamalı", async function () {
      const lowStake = ethers.parseEther("0.01");
      await expect(
        coordinator.connect(worker1).registerParticipant({ value: lowStake })
      ).to.be.revertedWith("FL: yetersiz stake");
    });

    it("Aynı adres tekrar kayıt olamamalı", async function () {
      await coordinator.connect(worker1).registerParticipant({ value: MIN_STAKE });
      await expect(
        coordinator.connect(worker1).registerParticipant({ value: MIN_STAKE })
      ).to.be.revertedWith("FL: zaten kayitli");
    });

    it("Kayıt eventi yayınlanmalı", async function () {
      await expect(coordinator.connect(worker1).registerParticipant({ value: MIN_STAKE }))
        .to.emit(coordinator, "ParticipantRegistered")
        .withArgs(worker1.address, MIN_STAKE, await getBlockTimestamp());
    });

    it("Deaktivasyon ile stake geri alınmalı", async function () {
      await coordinator.connect(worker1).registerParticipant({ value: MIN_STAKE });

      const balanceBefore = await ethers.provider.getBalance(worker1.address);
      const tx = await coordinator.connect(worker1).deactivateParticipant();
      const receipt = await tx.wait();
      const gasCost = receipt.gasUsed * receipt.gasPrice;
      const balanceAfter = await ethers.provider.getBalance(worker1.address);

      // Stake geri gelmeli (gas düşüldükten sonra)
      expect(balanceAfter + gasCost - balanceBefore).to.equal(MIN_STAKE);

      const p = await coordinator.getParticipant(worker1.address);
      expect(p.isActive).to.be.false;
    });

    it("Ek stake yatırılabilmeli", async function () {
      await coordinator.connect(worker1).registerParticipant({ value: MIN_STAKE });
      const extra = ethers.parseEther("0.5");
      await coordinator.connect(worker1).addStake({ value: extra });

      const p = await coordinator.getParticipant(worker1.address);
      expect(p.stake).to.equal(MIN_STAKE + extra);
    });

    it("Aktif katılımcı sayısı doğru takip edilmeli", async function () {
      await coordinator.connect(worker1).registerParticipant({ value: MIN_STAKE });
      await coordinator.connect(worker2).registerParticipant({ value: MIN_STAKE });
      expect(await coordinator.activeParticipantCount()).to.equal(2);

      await coordinator.connect(worker1).deactivateParticipant();
      expect(await coordinator.activeParticipantCount()).to.equal(1);
    });
  });

  // =========================================================================
  //                       ROUND YÖNETİMİ
  // =========================================================================

  describe("Round Yönetimi", function () {
    const MODEL_CID = "QmXoYpPmKNHCTLHHZxzoCm5FqXsYBbP3bNk3Z76S1KBZZA";

    it("Aggregator yeni tur başlatabilmeli", async function () {
      await coordinator.connect(aggregator).initializeRound(MODEL_CID);

      expect(await coordinator.currentRound()).to.equal(1);
      const round = await coordinator.getRoundInfo(1);
      expect(round.globalModelCID).to.equal(MODEL_CID);
      expect(round.isCompleted).to.be.false;
    });

    it("Owner da yeni tur başlatabilmeli", async function () {
      await coordinator.connect(owner).initializeRound(MODEL_CID);
      expect(await coordinator.currentRound()).to.equal(1);
    });

    it("Random kullanıcı tur başlatamamalı", async function () {
      await expect(
        coordinator.connect(worker1).initializeRound(MODEL_CID)
      ).to.be.revertedWith("FL: yalnizca aggregator");
    });

    it("Boş CID ile tur başlatılamamalı", async function () {
      await expect(
        coordinator.connect(aggregator).initializeRound("")
      ).to.be.revertedWith("FL: bos CID");
    });

    it("Önceki tur tamamlanmadan yeni tur başlatılamamalı", async function () {
      await coordinator.connect(aggregator).initializeRound(MODEL_CID);
      await expect(
        coordinator.connect(aggregator).initializeRound(MODEL_CID)
      ).to.be.revertedWith("FL: onceki tur tamamlanmamis");
    });

    it("Tur ile birlikte ödül havuzu fonlanabilmeli", async function () {
      const fund = ethers.parseEther("1.0");
      await coordinator.connect(aggregator).initializeRound(MODEL_CID, { value: fund });

      const round = await coordinator.getRoundInfo(1);
      expect(round.rewardPool).to.equal(fund);
    });
  });

  // =========================================================================
  //                    GÜNCELLEME GÖNDERİMİ
  // =========================================================================

  describe("Güncelleme Gönderimi", function () {
    const MODEL_CID = "QmXoYpPmKNHCTLHHZxzoCm5FqXsYBbP3bNk3Z76S1KBZZA";
    const UPDATE_CID_1 = "QmUpdate111111111111111111111111111111111111";
    const UPDATE_CID_2 = "QmUpdate222222222222222222222222222222222222";

    beforeEach(async function () {
      // Katılımcıları kaydet
      await coordinator.connect(worker1).registerParticipant({ value: MIN_STAKE });
      await coordinator.connect(worker2).registerParticipant({ value: MIN_STAKE });
      await coordinator.connect(worker3).registerParticipant({ value: MIN_STAKE });

      // Turu başlat
      await coordinator.connect(aggregator).initializeRound(MODEL_CID, {
        value: ethers.parseEther("0.5")
      });
    });

    it("Aktif katılımcı güncelleme gönderebilmeli", async function () {
      await coordinator.connect(worker1).submitLocalUpdate(1, UPDATE_CID_1);

      const update = await coordinator.getLocalUpdate(1, worker1.address);
      expect(update.updateCID).to.equal(UPDATE_CID_1);
      expect(update.isVerified).to.be.false;
    });

    it("Kayıtsız kullanıcı güncelleme gönderememeli", async function () {
      await expect(
        coordinator.connect(malicious).submitLocalUpdate(1, UPDATE_CID_1)
      ).to.be.revertedWith("FL: aktif katilimci degil");
    });

    it("Aynı turda iki kez güncelleme gönderilememeli", async function () {
      await coordinator.connect(worker1).submitLocalUpdate(1, UPDATE_CID_1);
      await expect(
        coordinator.connect(worker1).submitLocalUpdate(1, UPDATE_CID_2)
      ).to.be.revertedWith("FL: zaten guncelleme gonderilmis");
    });

    it("Güncelleme event'i yayınlanmalı", async function () {
      await expect(coordinator.connect(worker1).submitLocalUpdate(1, UPDATE_CID_1))
        .to.emit(coordinator, "LocalUpdateSubmitted");
    });

    it("Yeterli güncelleme geldiğinde tur tamamlanmalı", async function () {
      await coordinator.connect(worker1).submitLocalUpdate(1, UPDATE_CID_1);
      await coordinator.connect(worker2).submitLocalUpdate(1, UPDATE_CID_2);

      // MIN_UPDATES = 2, dolayısıyla 2. güncelleme ile tur tamamlanmalı
      const round = await coordinator.getRoundInfo(1);
      expect(round.isCompleted).to.be.true;
      expect(round.updateCount).to.equal(2);
    });

    it("Tur katılımcıları listesi doğru olmalı", async function () {
      await coordinator.connect(worker1).submitLocalUpdate(1, UPDATE_CID_1);
      await coordinator.connect(worker2).submitLocalUpdate(1, UPDATE_CID_2);

      const parts = await coordinator.getRoundParticipants(1);
      expect(parts.length).to.equal(2);
      expect(parts).to.include(worker1.address);
      expect(parts).to.include(worker2.address);
    });
  });

  // =========================================================================
  //                      DOĞRULAMA & BİRLEŞTİRME
  // =========================================================================

  describe("Doğrulama ve Birleştirme", function () {
    const MODEL_CID = "QmModel1111111111111111111111111111111111111";
    const MODEL_CID_2 = "QmModel2222222222222222222222222222222222222";
    const UPDATE_CID_1 = "QmUpd111111111111111111111111111111111111111";
    const UPDATE_CID_2 = "QmUpd222222222222222222222222222222222222222";

    beforeEach(async function () {
      await coordinator.connect(worker1).registerParticipant({ value: MIN_STAKE });
      await coordinator.connect(worker2).registerParticipant({ value: MIN_STAKE });

      await coordinator.connect(aggregator).initializeRound(MODEL_CID, {
        value: ethers.parseEther("1.0")
      });

      await coordinator.connect(worker1).submitLocalUpdate(1, UPDATE_CID_1);
      await coordinator.connect(worker2).submitLocalUpdate(1, UPDATE_CID_2);
    });

    it("Aggregator güncellemeyi doğrulayabilmeli", async function () {
      await coordinator.connect(aggregator).verifyUpdate(1, worker1.address, true);

      const update = await coordinator.getLocalUpdate(1, worker1.address);
      expect(update.isVerified).to.be.true;
    });

    it("Toplu doğrulama yapılabilmeli", async function () {
      await coordinator.connect(aggregator).batchVerifyUpdates(
        1,
        [worker1.address, worker2.address]
      );

      const u1 = await coordinator.getLocalUpdate(1, worker1.address);
      const u2 = await coordinator.getLocalUpdate(1, worker2.address);
      expect(u1.isVerified).to.be.true;
      expect(u2.isVerified).to.be.true;
    });

    it("Doğrulama itibar puanını artırmalı", async function () {
      const repBefore = (await coordinator.getParticipant(worker1.address)).reputation;
      await coordinator.connect(aggregator).verifyUpdate(1, worker1.address, true);
      const repAfter = (await coordinator.getParticipant(worker1.address)).reputation;
      expect(repAfter).to.be.greaterThan(repBefore);
    });

    it("Geçersiz doğrulama itibar puanını düşürmeli", async function () {
      const repBefore = (await coordinator.getParticipant(worker1.address)).reputation;
      await coordinator.connect(aggregator).verifyUpdate(1, worker1.address, false);
      const repAfter = (await coordinator.getParticipant(worker1.address)).reputation;
      expect(repAfter).to.be.lessThan(repBefore);
    });

    it("Birleştirme sonrası yeni tur başlatılabilmeli", async function () {
      await coordinator.connect(aggregator).batchVerifyUpdates(
        1,
        [worker1.address, worker2.address]
      );

      await coordinator.connect(aggregator).aggregateAndStartNextRound(1, MODEL_CID_2, {
        value: ethers.parseEther("0.5")
      });

      expect(await coordinator.currentRound()).to.equal(2);

      const newRound = await coordinator.getRoundInfo(2);
      expect(newRound.globalModelCID).to.equal(MODEL_CID_2);
      expect(newRound.isCompleted).to.be.false;

      const oldRound = await coordinator.getRoundInfo(1);
      expect(oldRound.isAggregated).to.be.true;
    });
  });

  // =========================================================================
  //                        ÖDÜL DAĞITIMI
  // =========================================================================

  describe("Ödül Dağıtımı", function () {
    const MODEL_CID = "QmModel1111111111111111111111111111111111111";
    const MODEL_CID_2 = "QmModel2222222222222222222222222222222222222";

    beforeEach(async function () {
      await coordinator.connect(worker1).registerParticipant({ value: MIN_STAKE });
      await coordinator.connect(worker2).registerParticipant({ value: MIN_STAKE });

      // Ödül havuzunu fonla
      await coordinator.fundRewardPool({ value: ethers.parseEther("5.0") });

      // Tur başlat
      await coordinator.connect(aggregator).initializeRound(MODEL_CID, {
        value: ethers.parseEther("1.0")
      });

      // Güncellemeleri gönder
      await coordinator.connect(worker1).submitLocalUpdate(1, "QmU1");
      await coordinator.connect(worker2).submitLocalUpdate(1, "QmU2");

      // Doğrula
      await coordinator.connect(aggregator).batchVerifyUpdates(
        1,
        [worker1.address, worker2.address]
      );
    });

    it("Birleştirme sonrası ödüller biriktirilmeli", async function () {
      await coordinator.connect(aggregator).aggregateAndStartNextRound(1, MODEL_CID_2);

      const p1Rewards = await coordinator.pendingRewards(worker1.address);
      const p2Rewards = await coordinator.pendingRewards(worker2.address);

      expect(p1Rewards).to.be.greaterThan(0);
      expect(p2Rewards).to.be.greaterThan(0);
    });

    it("Ödüller talep edilebilmeli", async function () {
      await coordinator.connect(aggregator).aggregateAndStartNextRound(1, MODEL_CID_2);

      const pendingBefore = await coordinator.pendingRewards(worker1.address);
      expect(pendingBefore).to.be.greaterThan(0);

      const balanceBefore = await ethers.provider.getBalance(worker1.address);
      const tx = await coordinator.connect(worker1).claimReward();
      const receipt = await tx.wait();
      const gasCost = receipt.gasUsed * receipt.gasPrice;
      const balanceAfter = await ethers.provider.getBalance(worker1.address);

      expect(balanceAfter + gasCost - balanceBefore).to.equal(pendingBefore);
      expect(await coordinator.pendingRewards(worker1.address)).to.equal(0);
    });

    it("Ödül yokken talep edilememeli", async function () {
      await expect(
        coordinator.connect(malicious).claimReward()
      ).to.be.revertedWith("FL: talep edilecek odul yok");
    });
  });

  // =========================================================================
  //                     CEZA MEKANİZMASI
  // =========================================================================

  describe("Ceza Mekanizması (Slashing)", function () {
    beforeEach(async function () {
      await coordinator.connect(worker1).registerParticipant({ value: ethers.parseEther("1.0") });
    });

    it("Aggregator kötü niyetli düğümü cezalandırabilmeli", async function () {
      await coordinator.connect(aggregator).slashParticipant(
        worker1.address,
        "Bozuk model guncellemesi"
      );

      const p = await coordinator.getParticipant(worker1.address);
      expect(p.isSlashed).to.be.true;
      expect(p.isActive).to.be.false;
      expect(p.reputation).to.equal(0);

      // Stake'in %30'u kesilmeli
      const expectedRemaining = ethers.parseEther("0.7");
      expect(p.stake).to.equal(expectedRemaining);
    });

    it("Cezalandırılmış kullanıcı tekrar kayıt olamamalı", async function () {
      await coordinator.connect(aggregator).slashParticipant(worker1.address, "spam");

      await expect(
        coordinator.connect(worker1).registerParticipant({ value: MIN_STAKE })
      ).to.be.revertedWith("FL: cezalandirilmis hesap");
    });

    it("Ceza eventi yayınlanmalı", async function () {
      const slashAmount = ethers.parseEther("0.3"); // 1.0 * 30%
      await expect(
        coordinator.connect(aggregator).slashParticipant(worker1.address, "invalid update")
      )
        .to.emit(coordinator, "ParticipantSlashed")
        .withArgs(worker1.address, slashAmount, "invalid update");
    });
  });

  // =========================================================================
  //                      İSTATİSTİKLER
  // =========================================================================

  describe("İstatistikler", function () {
    it("Genel istatistikler doğru olmalı", async function () {
      await coordinator.connect(worker1).registerParticipant({ value: MIN_STAKE });
      await coordinator.connect(worker2).registerParticipant({ value: MIN_STAKE });

      const stats = await coordinator.getStats();
      expect(stats._activeParticipants).to.equal(2);
      expect(stats._totalStaked).to.equal(MIN_STAKE * 2n);
      expect(stats._currentRound).to.equal(0);
    });

    it("Sözleşme bakiyesi doğru olmalı", async function () {
      await coordinator.connect(worker1).registerParticipant({ value: MIN_STAKE });
      await coordinator.fundRewardPool({ value: ethers.parseEther("1.0") });

      const balance = await coordinator.getContractBalance();
      expect(balance).to.equal(MIN_STAKE + ethers.parseEther("1.0"));
    });
  });

  // =========================================================================
  //                     YÖNETİM FONKSİYONLARI
  // =========================================================================

  describe("Yönetim Fonksiyonları", function () {
    it("Owner konfigürasyon güncelleyebilmeli", async function () {
      await coordinator.setMinStake(ethers.parseEther("0.5"));
      expect(await coordinator.minStake()).to.equal(ethers.parseEther("0.5"));

      await coordinator.setRoundDuration(7200);
      expect(await coordinator.roundDuration()).to.equal(7200);

      await coordinator.setSlashPercentage(50);
      expect(await coordinator.slashPercentage()).to.equal(50);
    });

    it("Random kullanıcı konfigürasyon güncelleyememeli", async function () {
      await expect(
        coordinator.connect(worker1).setMinStake(0)
      ).to.be.revertedWith("FL: yalnizca sahip");
    });

    it("Sahiplik devredilebilmeli", async function () {
      await coordinator.transferOwnership(worker1.address);
      expect(await coordinator.owner()).to.equal(worker1.address);
    });

    it("ZK verifier ayarlanabilmeli", async function () {
      const fakeVerifier = worker2.address;
      await coordinator.setZKVerifier(fakeVerifier);
      expect(await coordinator.zkVerifier()).to.equal(fakeVerifier);
    });
  });

  // =========================================================================
  //                     ZORLA TUR TAMAMLAMA
  // =========================================================================

  describe("Zorla Tur Tamamlama", function () {
    it("Süresi dolmuş tur zorla tamamlanabilmeli", async function () {
      await coordinator.connect(worker1).registerParticipant({ value: MIN_STAKE });

      // Kısa süreli tur başlat (60sn yeterli değildir test ortamında ileri alacağız)
      await coordinator.setRoundDuration(60);
      await coordinator.connect(aggregator).initializeRound("QmTest");

      // Zamanı ileri al
      await ethers.provider.send("evm_increaseTime", [120]);
      await ethers.provider.send("evm_mine");

      await coordinator.forceCompleteRound(1);
      const round = await coordinator.getRoundInfo(1);
      expect(round.isCompleted).to.be.true;
    });
  });

  // =========================================================================
  //                         YARDIMCI
  // =========================================================================

  async function getBlockTimestamp() {
    const block = await ethers.provider.getBlock("latest");
    return block.timestamp;
  }
});
