// ===== MONAD FL DASHBOARD — SIMULATION DATA ENGINE =====

const MONAD_TESTNET = {
  chainId: '0x279F',
  chainIdDecimal: 10143,
  chainName: 'Monad Testnet',
  rpcUrl: 'https://testnet-rpc.monad.xyz',
  blockExplorer: 'https://testnet.monadexplorer.com',
  currency: { name: 'MON', symbol: 'MON', decimals: 18 }
};

const CONTRACTS = {
  taskManager: {
    address: '0x7B3FE41a2D1b69E4c8A5F2d3C6B9F0E1D4A7C3B2',
    name: 'FL Task Manager',
    abi: [
      'function getCurrentRound() view returns (uint256)',
      'function getGlobalAccuracy() view returns (uint256)',
      'function getActiveNodes() view returns (uint256)',
      'function getTasks() view returns (tuple(uint256 id, string name, uint8 status, uint256 progress)[])',
      'event RoundCompleted(uint256 indexed round, uint256 accuracy)',
      'event TaskCreated(uint256 indexed taskId, string name)'
    ]
  },
  staking: {
    address: '0x4C1D95aB5b21B6E8D9F3A2C7E0F4D6B8A1C3E5F7',
    name: 'Staking Contract',
    abi: [
      'function stake() payable',
      'function getStake(address) view returns (uint256)',
      'function totalStaked() view returns (uint256)',
      'event Staked(address indexed user, uint256 amount)',
      'event Slashed(address indexed user, uint256 amount)'
    ]
  },
  aggregator: {
    address: '0x9B59B6C4D2E1F0A3B6C8D5E7F2A1B4C6D8E0F3A5',
    name: 'Aggregator',
    abi: [
      'function submitUpdate(bytes32 ipfsHash, bytes proof)',
      'function verifyUpdate(bytes32 hash) view returns (bool)',
      'function getLatestModelHash() view returns (bytes32)',
      'event UpdateSubmitted(address indexed worker, bytes32 ipfsHash)',
      'event UpdateVerified(bytes32 indexed hash, bool valid)'
    ]
  },
  rewards: {
    address: '0x2D1B69F4C8A5E2D3B6C9F0A1E4D7C3B2F5A8E6D0',
    name: 'Reward Distributor',
    abi: [
      'function claimRewards()',
      'function getPendingRewards(address) view returns (uint256)',
      'function getTotalDistributed() view returns (uint256)',
      'event RewardsClaimed(address indexed user, uint256 amount)',
      'event RewardsDistributed(uint256 round, uint256 totalAmount)'
    ]
  }
};

const DEVICE_TYPES = [
  { type: 'gpu', label: 'GPU Station', icon: '🖥️', color: '#FFAB91' },
  { type: 'mobile', label: 'Mobile Device', icon: '📱', color: '#81C784' },
  { type: 'server', label: 'Server', icon: '🖧', color: '#90CAF9' },
  { type: 'aggregator', label: 'Aggregator', icon: '🔗', color: '#FFD54F' }
];

const NODE_NAMES = [
  'Istanbul-GPU-01', 'Ankara-Server-03', 'Izmir-Mobile-07',
  'Berlin-GPU-02', 'London-Server-14', 'Tokyo-GPU-05',
  'NYC-Server-22', 'Dubai-Mobile-11', 'Paris-GPU-09',
  'Seoul-Server-18', 'SF-GPU-06', 'Toronto-Mobile-03',
  'Singapore-GPU-08', 'Mumbai-Server-12', 'Sydney-GPU-04',
  'Amsterdam-Server-16', 'Moscow-Mobile-09', 'Stockholm-GPU-10',
  'Helsinki-Server-20', 'Zurich-GPU-13', 'Oslo-Mobile-05',
  'Madrid-Server-25', 'Vienna-GPU-07', 'Prague-Mobile-02',
  'Lisbon-GPU-11', 'Monad-Aggregator-01'
];

function generateCID() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let cid = 'Qm';
  for (let i = 0; i < 44; i++) cid += chars.charAt(Math.floor(Math.random() * chars.length));
  return cid;
}

function generateHash() {
  let hash = '0x';
  const hex = '0123456789abcdef';
  for (let i = 0; i < 64; i++) hash += hex.charAt(Math.floor(Math.random() * 16));
  return hash;
}

function generateAddress() {
  let addr = '0x';
  const hex = '0123456789abcdef';
  for (let i = 0; i < 40; i++) addr += hex.charAt(Math.floor(Math.random() * 16));
  return addr;
}

function generateIPFSItems() {
  return [
    { name: 'Base Model v2.4 (ResNet-50)', cid: generateCID(), size: '124.7 MB', status: 'pinned', type: 'model' },
    { name: 'Round #' + SimState.currentRound + ' Global Update', cid: generateCID(), size: '18.3 MB', status: 'pinned', type: 'update' },
    { name: 'Round #' + (SimState.currentRound - 1) + ' Aggregated Weights', cid: generateCID(), size: '18.1 MB', status: 'pinned', type: 'weights' },
    { name: 'Training Configuration', cid: generateCID(), size: '2.4 KB', status: 'pinned', type: 'config' },
    { name: 'Round #' + (SimState.currentRound + 1) + ' Update (syncing)', cid: generateCID(), size: '17.9 MB', status: 'syncing', type: 'update' }
  ];
}

function generateTasks() {
  const round = SimState.currentRound;
  return [
    { id: round - 2, name: `Round #${round - 2}: Model Training`, details: `${SimState.activeNodes} nodes • ResNet-50 • CIFAR-10`, progress: 100, status: 'completed' },
    { id: round - 1, name: `Round #${round - 1}: Model Training`, details: `${SimState.activeNodes} nodes • ResNet-50 • CIFAR-10`, progress: 100, status: 'completed' },
    { id: round, name: `Round #${round}: Model Training`, details: `${SimState.activeNodes} nodes • ResNet-50 • CIFAR-10`, progress: SimState.roundProgress, status: 'in-progress' },
    { id: round + 1, name: `Round #${round + 1}: Model Training`, details: `Pending — Parameters being prepared`, progress: 0, status: 'pending' }
  ];
}

const ACTIVITY_TEMPLATES = {
  tx: [
    'Deposited {amount} MON to staking contract',
    'Aggregator contract verified update',
    'Reward distribution completed: {amount} MON',
    'New participant deposited collateral: {amount} MON',
    'Task manager started new round'
  ],
  model: [
    'Model update hash uploaded to IPFS',
    'Aggregator merged updates',
    'ZKP verification successful — Round #{round}',
    'Global model weights updated',
    'Differential privacy noise applied'
  ],
  reward: [
    '{node} claimed reward: {amount} MON',
    'Round #{round} rewards distributed',
    'Total {amount} MON added to reward pool'
  ],
  join: [
    '{node} joined the network',
    '{node} started training',
    'New node verified: {node}'
  ],
  alert: [
    '{node} disconnected',
    'Low accuracy warning: {node}',
    'Stake expiring soon: {node}'
  ]
};

function generateActivityMessage(type) {
  const templates = ACTIVITY_TEMPLATES[type];
  let msg = templates[Math.floor(Math.random() * templates.length)];
  msg = msg.replace('{amount}', (Math.random() * 5 + 0.1).toFixed(3));
  msg = msg.replace('{round}', SimState.currentRound);
  msg = msg.replace('{node}', NODE_NAMES[Math.floor(Math.random() * NODE_NAMES.length)]);
  return msg;
}

const SimState = {
  currentRound: 47, globalAccuracy: 87.3, activeNodes: 23,
  totalReward: 142.847, claimedReward: 98.200, pendingReward: 44.647,
  completedTasks: 46, roundProgress: 62, stakeTotal: 580.5,
  walletConnected: false, walletAddress: null,
  accuracyHistory: [72, 75, 78, 80, 82, 83, 85, 86, 87, 85, 86, 87],
  nodes: [],
  initNodes(canvasWidth, canvasHeight) {
    this.nodes = [];
    this.nodes.push({
      id: 'aggregator-01', name: 'Monad-Aggregator-01', type: 3,
      x: canvasWidth / 2, y: canvasHeight / 2, vx: 0, vy: 0,
      radius: 14, accuracy: 100, stake: 50.0, updates: 0, isAggregator: true
    });
    for (let i = 0; i < this.activeNodes; i++) {
      const typeIdx = i < 3 ? 2 : (i < 10 ? 0 : (Math.random() > 0.5 ? 0 : 1));
      const angle = (i / this.activeNodes) * Math.PI * 2;
      const dist = 80 + Math.random() * (Math.min(canvasWidth, canvasHeight) / 2 - 100);
      this.nodes.push({
        id: `node-${i}`, name: NODE_NAMES[i % NODE_NAMES.length], type: typeIdx,
        x: canvasWidth / 2 + Math.cos(angle) * dist, y: canvasHeight / 2 + Math.sin(angle) * dist,
        vx: (Math.random() - 0.5) * 0.3, vy: (Math.random() - 0.5) * 0.3,
        radius: 5 + Math.random() * 4, accuracy: 70 + Math.random() * 28,
        stake: 5 + Math.random() * 45, updates: Math.floor(Math.random() * 50), isAggregator: false
      });
    }
  }
};

window.MONAD_TESTNET = MONAD_TESTNET; window.CONTRACTS = CONTRACTS;
window.DEVICE_TYPES = DEVICE_TYPES; window.SimState = SimState;
window.generateCID = generateCID; window.generateHash = generateHash;
window.generateAddress = generateAddress; window.generateIPFSItems = generateIPFSItems;
window.generateTasks = generateTasks; window.generateActivityMessage = generateActivityMessage;
