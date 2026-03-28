// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title FLCoordinator
 * @author Monad FL Team
 * @notice Monad ağı üzerinde merkeziyetsiz Federated Learning koordinasyonu
 * @dev EVM uyumlu, Monad'ın paralel execution'ından faydalanacak şekilde optimize edilmiş.
 *
 * Mimari Notlar:
 * - Model ağırlıkları IPFS üzerinde saklanır, on-chain sadece CID tutulur
 * - FedAvg (Federated Averaging) off-chain yapılır, sonuç on-chain onaylanır
 * - ZKP alanı ilerideki entegrasyon için hazır bırakılmıştır
 * - Storage slot'ları Monad paralel execution için optimize edilmiştir
 */

/// @notice Tekrarlı giriş saldırılarına karşı koruma
abstract contract ReentrancyGuard {
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;
    uint256 private _status;

    constructor() {
        _status = _NOT_ENTERED;
    }

    modifier nonReentrant() {
        require(_status != _ENTERED, "ReentrancyGuard: reentrant call");
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }
}

contract FLCoordinator is ReentrancyGuard {

    // =========================================================================
    //                           VERI YAPILARI
    // =========================================================================

    /// @notice Katılımcı (Worker Node) bilgileri
    struct Participant {
        uint256 stake;           // Yatırılan MON miktarı
        uint256 reputation;      // İtibar puanı (0-1000)
        uint256 totalRewards;    // Toplam kazanılan ödül
        uint256 successfulRounds; // Başarılı tamamlanan tur sayısı
        uint256 joinedAt;        // Katılım zamanı
        bool isActive;           // Aktif mi?
        bool isSlashed;          // Cezalandırıldı mı?
    }

    /// @notice Bir eğitim turundaki yerel güncelleme bilgisi
    struct LocalUpdate {
        string updateCID;        // IPFS CID
        uint256 timestamp;       // Gönderim zamanı
        bool isVerified;         // Doğrulandı mı?
        bytes32 zkProofHash;     // ZK proof hash (opsiyonel)
    }

    /// @notice Eğitim turu bilgileri
    struct RoundInfo {
        string globalModelCID;     // IPFS'teki global model CID
        uint256 startTime;         // Başlangıç zamanı
        uint256 deadline;          // Son gönderim zamanı
        uint256 updateCount;       // Gelen güncelleme sayısı
        uint256 requiredUpdates;   // Minimum gereken güncelleme sayısı
        uint256 rewardPool;        // Bu tur için ödül havuzu
        bool isCompleted;          // Tamamlandı mı?
        bool isAggregated;         // Birleştirme yapıldı mı?
    }

    // =========================================================================
    //                          STATE DEĞİŞKENLERİ
    // =========================================================================

    // --- İdari ---
    address public owner;
    address public aggregator; // Güvenilir aggregator adresi

    // --- Katılımcı Yönetimi ---
    /// @dev Monad paralel execution: Katılımcı verileri bağımsız slot'larda
    mapping(address => Participant) public participants;
    address[] public participantList;
    uint256 public activeParticipantCount;

    // --- Round Yönetimi ---
    uint256 public currentRound;
    mapping(uint256 => RoundInfo) public rounds;

    // --- Round -> Katılımcı Güncellemeleri ---
    /// @dev İç içe mapping yerine ayrı slot kullanarak paralel erişime izin veriyoruz
    mapping(uint256 => mapping(address => LocalUpdate)) public roundUpdates;
    mapping(uint256 => address[]) public roundParticipants;

    // --- Ödül Yönetimi ---
    /// @dev Her katılımcının talep edilebilir ödülleri ayrı slot'ta
    mapping(address => uint256) public pendingRewards;

    // --- Konfigürasyon ---
    uint256 public minStake;           // Minimum stake miktarı (wei)
    uint256 public roundDuration;      // Tur süresi (saniye)
    uint256 public minUpdatesPerRound; // Tur başına minimum güncelleme
    uint256 public slashPercentage;    // Ceza yüzdesi (0-100)
    uint256 public rewardPerUpdate;    // Güncelleme başına ödül

    // --- ZKP Doğrulama (Placeholders) ---
    address public zkVerifier;         // ZK doğrulayıcı kontrat adresi
    bool public zkEnabled;             // ZKP zorunlu mu?

    // --- İstatistikler (Ayrı slot'lar - paralel okuma) ---
    uint256 public totalStaked;
    uint256 public totalRewardsDistributed;
    uint256 public totalSlashed;

    // =========================================================================
    //                             EVENTS
    // =========================================================================

    event ParticipantRegistered(address indexed participant, uint256 stake, uint256 timestamp);
    event ParticipantDeactivated(address indexed participant, uint256 stakeReturned);
    event ParticipantSlashed(address indexed participant, uint256 slashedAmount, string reason);

    event RoundInitialized(uint256 indexed roundId, string globalModelCID, uint256 deadline, uint256 rewardPool);
    event RoundCompleted(uint256 indexed roundId, uint256 updateCount, uint256 rewardDistributed);

    event LocalUpdateSubmitted(address indexed participant, uint256 indexed roundId, string updateCID, uint256 timestamp);
    event UpdateVerified(uint256 indexed roundId, address indexed participant, bool isValid);

    event AggregationCompleted(uint256 indexed roundId, string newGlobalCID);
    event NextRoundStarted(uint256 indexed newRoundId, string globalModelCID);

    event RewardClaimed(address indexed participant, uint256 amount);
    event RewardPoolFunded(uint256 amount, address indexed funder);

    event ZKVerifierUpdated(address newVerifier);
    event AggregatorUpdated(address newAggregator);
    event ConfigUpdated(string param, uint256 value);

    // =========================================================================
    //                           MODIFIERS
    // =========================================================================

    modifier onlyOwner() {
        require(msg.sender == owner, "FL: yalnizca sahip");
        _;
    }

    modifier onlyAggregator() {
        require(msg.sender == aggregator || msg.sender == owner, "FL: yalnizca aggregator");
        _;
    }

    modifier onlyActiveParticipant() {
        require(participants[msg.sender].isActive, "FL: aktif katilimci degil");
        require(!participants[msg.sender].isSlashed, "FL: cezalandirilmis katilimci");
        _;
    }

    modifier roundExists(uint256 _roundId) {
        require(_roundId > 0 && _roundId <= currentRound, "FL: gecersiz tur");
        _;
    }

    modifier roundActive(uint256 _roundId) {
        require(!rounds[_roundId].isCompleted, "FL: tur tamamlanmis");
        require(block.timestamp <= rounds[_roundId].deadline, "FL: tur suresi dolmus");
        _;
    }

    // =========================================================================
    //                          CONSTRUCTOR
    // =========================================================================

    constructor(
        uint256 _minStake,
        uint256 _roundDuration,
        uint256 _minUpdatesPerRound,
        uint256 _slashPercentage,
        uint256 _rewardPerUpdate
    ) {
        require(_minStake > 0, "FL: stake sifir olamaz");
        require(_roundDuration >= 60, "FL: tur suresi min 60sn");
        require(_minUpdatesPerRound > 0, "FL: min guncelleme > 0");
        require(_slashPercentage <= 100, "FL: ceza %100 asamaz");

        owner = msg.sender;
        aggregator = msg.sender; // Başlangıçta owner aynı zamanda aggregator

        minStake = _minStake;
        roundDuration = _roundDuration;
        minUpdatesPerRound = _minUpdatesPerRound;
        slashPercentage = _slashPercentage;
        rewardPerUpdate = _rewardPerUpdate;
    }

    // =========================================================================
    //                     KATILIMCI YÖNETİMİ
    // =========================================================================

    /**
     * @notice Sisteme katılmak için MON stake et
     * @dev Sybil attack önleme: Minimum stake gereksinimi
     *      Monad optimizasyon: Participant verisi tek mapping slot'unda
     */
    function registerParticipant() external payable nonReentrant {
        require(!participants[msg.sender].isActive, "FL: zaten kayitli");
        require(!participants[msg.sender].isSlashed, "FL: cezalandirilmis hesap");
        require(msg.value >= minStake, "FL: yetersiz stake");

        participants[msg.sender] = Participant({
            stake: msg.value,
            reputation: 500,      // Başlangıç itibarı: orta seviye
            totalRewards: 0,
            successfulRounds: 0,
            joinedAt: block.timestamp,
            isActive: true,
            isSlashed: false
        });

        participantList.push(msg.sender);
        activeParticipantCount++;
        totalStaked += msg.value;

        emit ParticipantRegistered(msg.sender, msg.value, block.timestamp);
    }

    /**
     * @notice Sistemden ayrıl ve stake'ini geri al
     * @dev Aktif tur varsa ve katılımcı güncelleme göndermişse ayrılamaz
     */
    function deactivateParticipant() external nonReentrant onlyActiveParticipant {
        // Aktif turda güncelleme göndermişse engelle
        if (currentRound > 0 && !rounds[currentRound].isCompleted) {
            require(
                bytes(roundUpdates[currentRound][msg.sender].updateCID).length == 0,
                "FL: aktif turda guncelleme var"
            );
        }

        Participant storage p = participants[msg.sender];
        uint256 stakeReturn = p.stake;

        p.isActive = false;
        p.stake = 0;
        activeParticipantCount--;
        totalStaked -= stakeReturn;

        // Bekleyen ödülleri de gönder
        uint256 pending = pendingRewards[msg.sender];
        pendingRewards[msg.sender] = 0;

        uint256 totalReturn = stakeReturn + pending;
        (bool success, ) = payable(msg.sender).call{value: totalReturn}("");
        require(success, "FL: transfer basarisiz");

        emit ParticipantDeactivated(msg.sender, totalReturn);
    }

    /**
     * @notice Ek stake yatır (itibar artırma)
     */
    function addStake() external payable onlyActiveParticipant {
        require(msg.value > 0, "FL: sifir stake");
        participants[msg.sender].stake += msg.value;
        totalStaked += msg.value;
    }

    // =========================================================================
    //                       ROUND YÖNETİMİ
    // =========================================================================

    /**
     * @notice Yeni eğitim turu başlat
     * @param _globalModelCID IPFS'teki global model adresi
     * @dev Yalnızca owner/aggregator çağırabilir
     *      Önceki tur tamamlanmış olmalı
     */
    function initializeRound(string calldata _globalModelCID) external payable onlyAggregator {
        require(bytes(_globalModelCID).length > 0, "FL: bos CID");

        // Önceki tur tamamlanmış olmalı (ilk tur hariç)
        if (currentRound > 0) {
            require(rounds[currentRound].isCompleted, "FL: onceki tur tamamlanmamis");
        }

        currentRound++;
        uint256 deadline = block.timestamp + roundDuration;

        rounds[currentRound] = RoundInfo({
            globalModelCID: _globalModelCID,
            startTime: block.timestamp,
            deadline: deadline,
            updateCount: 0,
            requiredUpdates: minUpdatesPerRound,
            rewardPool: msg.value,  // Tur ile birlikte ödül havuzu fonlanabilir
            isCompleted: false,
            isAggregated: false
        });

        emit RoundInitialized(currentRound, _globalModelCID, deadline, msg.value);
    }

    /**
     * @notice Aktif turun süresini uzat (acil durum)
     * @param _extraTime Eklenecek süre (saniye)
     */
    function extendRoundDeadline(uint256 _extraTime) external onlyOwner {
        require(currentRound > 0, "FL: tur yok");
        require(!rounds[currentRound].isCompleted, "FL: tur bitmis");
        rounds[currentRound].deadline += _extraTime;
    }

    // =========================================================================
    //                   YEREL GÜNCELLEME GÖNDERİMİ
    // =========================================================================

    /**
     * @notice Yerel eğitim sonucunu gönder
     * @param _roundId Tur numarası
     * @param _updateCID IPFS'teki güncelleme CID'si
     * @dev Monad optimizasyon: roundUpdates[roundId][sender] bağımsız slot'ta
     *      Her katılımcı kendi slot'una yazar, paralel execution mümkün
     */
    function submitLocalUpdate(
        uint256 _roundId,
        string calldata _updateCID
    )
        external
        onlyActiveParticipant
        roundExists(_roundId)
        roundActive(_roundId)
    {
        require(bytes(_updateCID).length > 0, "FL: bos CID");
        require(
            bytes(roundUpdates[_roundId][msg.sender].updateCID).length == 0,
            "FL: zaten guncelleme gonderilmis"
        );

        // Güncellemeyi kaydet
        roundUpdates[_roundId][msg.sender] = LocalUpdate({
            updateCID: _updateCID,
            timestamp: block.timestamp,
            isVerified: false,
            zkProofHash: bytes32(0)
        });

        roundParticipants[_roundId].push(msg.sender);
        rounds[_roundId].updateCount++;

        emit LocalUpdateSubmitted(msg.sender, _roundId, _updateCID, block.timestamp);

        // Yeterli güncelleme geldi mi kontrol et
        _checkRoundCompletion(_roundId);
    }

    /**
     * @notice Yerel güncelleme ile ZK proof gönder
     * @param _roundId Tur numarası
     * @param _updateCID IPFS'teki güncelleme CID'si
     * @param _zkProofHash ZK proof hash'i
     * @dev ZKP entegrasyonu için hazırlanmış fonksiyon
     */
    function submitLocalUpdateWithProof(
        uint256 _roundId,
        string calldata _updateCID,
        bytes32 _zkProofHash
    )
        external
        onlyActiveParticipant
        roundExists(_roundId)
        roundActive(_roundId)
    {
        require(bytes(_updateCID).length > 0, "FL: bos CID");
        require(
            bytes(roundUpdates[_roundId][msg.sender].updateCID).length == 0,
            "FL: zaten guncelleme gonderilmis"
        );

        // ZKP doğrulaması aktifse kontrol et
        if (zkEnabled && zkVerifier != address(0)) {
            require(_verifyZKProof(_zkProofHash, msg.sender, _roundId), "FL: ZK proof gecersiz");
        }

        roundUpdates[_roundId][msg.sender] = LocalUpdate({
            updateCID: _updateCID,
            timestamp: block.timestamp,
            isVerified: zkEnabled, // ZKP aktifse otomatik doğrulanmış say
            zkProofHash: _zkProofHash
        });

        roundParticipants[_roundId].push(msg.sender);
        rounds[_roundId].updateCount++;

        emit LocalUpdateSubmitted(msg.sender, _roundId, _updateCID, block.timestamp);

        _checkRoundCompletion(_roundId);
    }

    // =========================================================================
    //                      DOĞRULAMA MEKANİZMASI
    // =========================================================================

    /**
     * @notice Bir güncellemeyi doğrula veya reddet
     * @param _roundId Tur numarası
     * @param _participant Katılımcı adresi
     * @param _isValid Geçerli mi?
     * @dev Off-chain doğrulama sonucu on-chain kaydedilir
     */
    function verifyUpdate(
        uint256 _roundId,
        address _participant,
        bool _isValid
    )
        external
        onlyAggregator
        roundExists(_roundId)
    {
        LocalUpdate storage update = roundUpdates[_roundId][_participant];
        require(bytes(update.updateCID).length > 0, "FL: guncelleme bulunamadi");

        update.isVerified = _isValid;

        if (_isValid) {
            // İtibar artır
            Participant storage p = participants[_participant];
            if (p.reputation < 1000) {
                p.reputation = p.reputation + 10 > 1000 ? 1000 : p.reputation + 10;
            }
        } else {
            // Geçersiz güncelleme: itibar düşür
            Participant storage p = participants[_participant];
            p.reputation = p.reputation > 50 ? p.reputation - 50 : 0;
        }

        emit UpdateVerified(_roundId, _participant, _isValid);
    }

    /**
     * @notice Bir turdaki tüm güncellemeleri toplu doğrula
     * @param _roundId Tur numarası
     * @param _validParticipants Geçerli katılımcı adresleri
     * @dev Gas optimizasyonu: Tek TX'te toplu doğrulama
     */
    function batchVerifyUpdates(
        uint256 _roundId,
        address[] calldata _validParticipants
    )
        external
        onlyAggregator
        roundExists(_roundId)
    {
        for (uint256 i = 0; i < _validParticipants.length; i++) {
            LocalUpdate storage update = roundUpdates[_roundId][_validParticipants[i]];
            if (bytes(update.updateCID).length > 0) {
                update.isVerified = true;

                // İtibar artır
                Participant storage p = participants[_validParticipants[i]];
                if (p.reputation < 1000) {
                    p.reputation = p.reputation + 10 > 1000 ? 1000 : p.reputation + 10;
                }

                emit UpdateVerified(_roundId, _validParticipants[i], true);
            }
        }
    }

    /**
     * @dev ZK proof doğrulama placeholder'ı
     *      İleride zkVerifier kontratına delegate edilecek
     */
    function _verifyZKProof(
        bytes32 _proofHash,
        address _participant,
        uint256 _roundId
    ) internal view returns (bool) {
        // TODO: ZK verifier kontratına çağrı
        // IZKVerifier(zkVerifier).verify(_proofHash, _participant, _roundId)
        //
        // Şimdilik: proof hash sıfır değilse geçerli say
        return _proofHash != bytes32(0);
    }

    // =========================================================================
    //                   BİRLEŞTİRME (AGGREGATION)
    // =========================================================================

    /**
     * @notice Off-chain birleştirme sonucunu onayla ve yeni turu başlat
     * @param _completedRoundId Tamamlanan tur
     * @param _newGlobalCID Yeni global model CID (aggregation sonucu)
     * @dev FedAvg off-chain yapılır, sadece sonuç CID on-chain kaydedilir
     */
    function aggregateAndStartNextRound(
        uint256 _completedRoundId,
        string calldata _newGlobalCID
    )
        external
        payable
        onlyAggregator
        roundExists(_completedRoundId)
    {
        RoundInfo storage round = rounds[_completedRoundId];
        require(round.isCompleted, "FL: tur henuz tamamlanmamis");
        require(!round.isAggregated, "FL: zaten birlestirilmis");

        round.isAggregated = true;

        emit AggregationCompleted(_completedRoundId, _newGlobalCID);

        // Doğrulanmış katılımcılara ödül dağıt
        _distributeRoundRewards(_completedRoundId);

        // Yeni turu otomatik başlat (isteğe bağlı)
        if (bytes(_newGlobalCID).length > 0) {
            currentRound++;
            uint256 deadline = block.timestamp + roundDuration;

            rounds[currentRound] = RoundInfo({
                globalModelCID: _newGlobalCID,
                startTime: block.timestamp,
                deadline: deadline,
                updateCount: 0,
                requiredUpdates: minUpdatesPerRound,
                rewardPool: msg.value,
                isCompleted: false,
                isAggregated: false
            });

            emit NextRoundStarted(currentRound, _newGlobalCID);
        }
    }

    // =========================================================================
    //                      ÖDÜL DAĞITIMI
    // =========================================================================

    /**
     * @notice Bir turun ödüllerini dağıt
     * @param _roundId Tur numarası
     * @dev İtibar ağırlıklı ödül dağıtımı
     *      Monad optimizasyon: Her katılımcının ödülü kendi slot'unda
     */
    function _distributeRoundRewards(uint256 _roundId) internal {
        address[] storage roundParts = roundParticipants[_roundId];
        RoundInfo storage round = rounds[_roundId];

        uint256 verifiedCount = 0;
        uint256 totalReputation = 0;

        // İlk geçiş: doğrulanmış katılımcıları say ve toplam itibarı hesapla
        for (uint256 i = 0; i < roundParts.length; i++) {
            if (roundUpdates[_roundId][roundParts[i]].isVerified) {
                verifiedCount++;
                totalReputation += participants[roundParts[i]].reputation;
            }
        }

        if (verifiedCount == 0 || totalReputation == 0) return;

        // Ödül havuzu: round.rewardPool + birikmiş rewardPerUpdate
        uint256 totalPool = round.rewardPool + (rewardPerUpdate * verifiedCount);

        // Sözleşmede yeterli bakiye kontrolü
        uint256 availablePool = totalPool > address(this).balance
            ? address(this).balance
            : totalPool;

        if (availablePool == 0) return;

        // İkinci geçiş: itibar-ağırlıklı ödül dağıtımı
        for (uint256 i = 0; i < roundParts.length; i++) {
            address participant = roundParts[i];
            if (roundUpdates[_roundId][participant].isVerified) {
                // İtibar ağırlıklı pay hesapla
                uint256 share = (availablePool * participants[participant].reputation) / totalReputation;

                pendingRewards[participant] += share;
                participants[participant].totalRewards += share;
                participants[participant].successfulRounds++;
                totalRewardsDistributed += share;
            }
        }

        emit RoundCompleted(_roundId, verifiedCount, availablePool);
    }

    /**
     * @notice Biriken ödülleri talep et
     * @dev Monad optimizasyon: Her kullanıcı kendi slot'undan okur/yazar
     */
    function claimReward() external nonReentrant {
        uint256 amount = pendingRewards[msg.sender];
        require(amount > 0, "FL: talep edilecek odul yok");

        pendingRewards[msg.sender] = 0;

        (bool success, ) = payable(msg.sender).call{value: amount}("");
        require(success, "FL: transfer basarisiz");

        emit RewardClaimed(msg.sender, amount);
    }

    /**
     * @notice Ödül havuzunu fonla
     * @dev Herkes ödül havuzuna katkıda bulunabilir
     */
    function fundRewardPool() external payable {
        require(msg.value > 0, "FL: sifir miktar");
        emit RewardPoolFunded(msg.value, msg.sender);
    }

    // =========================================================================
    //                     CEZA MEKANİZMASI (SLASHING)
    // =========================================================================

    /**
     * @notice Kötü niyetli düğümün stake'ine el koy
     * @param _maliciousNode Cezalandırılacak adres
     * @param _reason Ceza nedeni
     * @dev Slashing: Dürüst davranışı teşvik eder
     */
    function slashParticipant(
        address _maliciousNode,
        string calldata _reason
    )
        external
        onlyAggregator
    {
        Participant storage p = participants[_maliciousNode];
        require(p.isActive, "FL: katilimci aktif degil");
        require(!p.isSlashed, "FL: zaten cezalandirilmis");

        uint256 slashAmount = (p.stake * slashPercentage) / 100;

        p.stake -= slashAmount;
        p.isSlashed = true;
        p.isActive = false;
        p.reputation = 0;
        activeParticipantCount--;
        totalStaked -= slashAmount;
        totalSlashed += slashAmount;

        // Cezalanan miktar sözleşmede kalır (ödül havuzuna aktarılabilir)
        emit ParticipantSlashed(_maliciousNode, slashAmount, _reason);
    }

    // =========================================================================
    //                      YÖNETİM FONKSİYONLARI
    // =========================================================================

    /// @notice Aggregator adresini güncelle
    function setAggregator(address _newAggregator) external onlyOwner {
        require(_newAggregator != address(0), "FL: gecersiz adres");
        aggregator = _newAggregator;
        emit AggregatorUpdated(_newAggregator);
    }

    /// @notice ZK doğrulayıcı kontratını ayarla
    function setZKVerifier(address _verifier) external onlyOwner {
        zkVerifier = _verifier;
        emit ZKVerifierUpdated(_verifier);
    }

    /// @notice ZKP zorunluluğunu aç/kapat
    function setZKEnabled(bool _enabled) external onlyOwner {
        zkEnabled = _enabled;
    }

    /// @notice Minimum stake miktarını güncelle
    function setMinStake(uint256 _minStake) external onlyOwner {
        require(_minStake > 0, "FL: sifir stake");
        minStake = _minStake;
        emit ConfigUpdated("minStake", _minStake);
    }

    /// @notice Tur süresini güncelle
    function setRoundDuration(uint256 _duration) external onlyOwner {
        require(_duration >= 60, "FL: min 60sn");
        roundDuration = _duration;
        emit ConfigUpdated("roundDuration", _duration);
    }

    /// @notice Minimum güncelleme sayısını güncelle
    function setMinUpdatesPerRound(uint256 _count) external onlyOwner {
        require(_count > 0, "FL: min > 0");
        minUpdatesPerRound = _count;
        emit ConfigUpdated("minUpdatesPerRound", _count);
    }

    /// @notice Ceza yüzdesini güncelle
    function setSlashPercentage(uint256 _percentage) external onlyOwner {
        require(_percentage <= 100, "FL: max %100");
        slashPercentage = _percentage;
        emit ConfigUpdated("slashPercentage", _percentage);
    }

    /// @notice Güncelleme başına ödülü güncelle
    function setRewardPerUpdate(uint256 _reward) external onlyOwner {
        rewardPerUpdate = _reward;
        emit ConfigUpdated("rewardPerUpdate", _reward);
    }

    /// @notice Sahipliği devret
    function transferOwnership(address _newOwner) external onlyOwner {
        require(_newOwner != address(0), "FL: gecersiz adres");
        owner = _newOwner;
    }

    // =========================================================================
    //                       GÖRÜNTÜLEME (VIEW)
    // =========================================================================

    /// @notice Katılımcı bilgilerini getir
    function getParticipant(address _addr) external view returns (
        uint256 stake,
        uint256 reputation,
        uint256 totalRewards,
        uint256 successfulRounds,
        uint256 joinedAt,
        bool isActive,
        bool isSlashed
    ) {
        Participant storage p = participants[_addr];
        return (p.stake, p.reputation, p.totalRewards, p.successfulRounds, p.joinedAt, p.isActive, p.isSlashed);
    }

    /// @notice Tur bilgilerini getir
    function getRoundInfo(uint256 _roundId) external view returns (
        string memory globalModelCID,
        uint256 startTime,
        uint256 deadline,
        uint256 updateCount,
        uint256 requiredUpdates,
        uint256 rewardPool,
        bool isCompleted,
        bool isAggregated
    ) {
        RoundInfo storage r = rounds[_roundId];
        return (r.globalModelCID, r.startTime, r.deadline, r.updateCount, r.requiredUpdates, r.rewardPool, r.isCompleted, r.isAggregated);
    }

    /// @notice Bir katılımcının belirli turdaki güncellemesini getir
    function getLocalUpdate(uint256 _roundId, address _participant) external view returns (
        string memory updateCID,
        uint256 timestamp,
        bool isVerified,
        bytes32 zkProofHash
    ) {
        LocalUpdate storage u = roundUpdates[_roundId][_participant];
        return (u.updateCID, u.timestamp, u.isVerified, u.zkProofHash);
    }

    /// @notice Bir turdaki tüm katılımcı adreslerini getir
    function getRoundParticipants(uint256 _roundId) external view returns (address[] memory) {
        return roundParticipants[_roundId];
    }

    /// @notice Toplam katılımcı sayısını getir
    function getTotalParticipants() external view returns (uint256) {
        return participantList.length;
    }

    /// @notice Sözleşme bakiyesini getir
    function getContractBalance() external view returns (uint256) {
        return address(this).balance;
    }

    /// @notice Genel istatistikleri getir
    function getStats() external view returns (
        uint256 _currentRound,
        uint256 _activeParticipants,
        uint256 _totalStaked,
        uint256 _totalRewardsDistributed,
        uint256 _totalSlashed,
        uint256 _contractBalance
    ) {
        return (
            currentRound,
            activeParticipantCount,
            totalStaked,
            totalRewardsDistributed,
            totalSlashed,
            address(this).balance
        );
    }

    // =========================================================================
    //                       İÇ FONKSİYONLAR
    // =========================================================================

    /**
     * @dev Tur tamamlanma koşulunu kontrol et
     *      Yeterli güncelleme geldiyse otomatik tamamla
     */
    function _checkRoundCompletion(uint256 _roundId) internal {
        RoundInfo storage round = rounds[_roundId];

        if (round.updateCount >= round.requiredUpdates && !round.isCompleted) {
            round.isCompleted = true;
            // Aggregator'ün birleştirme yapmasını bekle
        }
    }

    /**
     * @notice Süresi dolmuş turu zorla tamamla
     * @param _roundId Tur numarası
     * @dev Herkes çağırabilir, ancak sadece süresi dolmuşsa çalışır
     */
    function forceCompleteRound(uint256 _roundId) external roundExists(_roundId) {
        RoundInfo storage round = rounds[_roundId];
        require(!round.isCompleted, "FL: zaten tamamlanmis");
        require(block.timestamp > round.deadline, "FL: sure dolmamis");

        round.isCompleted = true;
        emit RoundCompleted(_roundId, round.updateCount, 0);
    }

    // =========================================================================
    //                          RECEIVE / FALLBACK
    // =========================================================================

    /// @notice Doğrudan MON transfer almayı kabul et (ödül havuzu fonlama)
    receive() external payable {
        emit RewardPoolFunded(msg.value, msg.sender);
    }

    fallback() external payable {
        emit RewardPoolFunded(msg.value, msg.sender);
    }
}
