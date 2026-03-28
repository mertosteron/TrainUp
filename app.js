// ===== TRAINUP — MAIN APPLICATION =====
(function () {
  'use strict';

  let provider = null, signer = null, animFrameId = null;
  let canvas, ctx, simInterval = null, activityInterval = null, hoveredNode = null;

  document.addEventListener('DOMContentLoaded', () => {
    renderContractAddresses();
    renderOwnerModels();
    renderTaskList();
    updateRewardDisplay();
    startSimulation();
    startActivityFeed();
    buildAccuracyChart();
    addInitialActivities();
    initCanvas();
  });

  // ===== ROLE SWITCHING =====
  window.switchRole = function(role) {
    document.getElementById('viewOwner').classList.toggle('hidden', role !== 'owner');
    document.getElementById('viewNode').classList.toggle('hidden', role !== 'node');
    document.getElementById('tabOwner').classList.toggle('active', role === 'owner');
    document.getElementById('tabNode').classList.toggle('active', role === 'node');
    if (role === 'node' && canvas) {
      const wrapper = canvas.parentElement;
      canvas.width = wrapper.clientWidth;
      canvas.height = wrapper.clientHeight;
      SimState.initNodes(canvas.width, canvas.height);
    }
  };

  // ===== OWNER MODELS LIST =====
  function renderOwnerModels() {
    const list = document.getElementById('ownerModelList');
    const models = [
      { name: 'ResNet-50', dataset: 'CIFAR-10', round: 47, status: 'training', icon: '🧠' },
      { name: 'GPT-Mini', dataset: 'Custom Text', round: 12, status: 'training', icon: '💬' },
      { name: 'EfficientNet-B0', dataset: 'ImageNet Subset', round: 30, status: 'completed', icon: '🖼️' },
    ];
    list.innerHTML = models.map(m => `
      <div class="model-row">
        <div class="model-icon">${m.icon}</div>
        <div class="model-info">
          <div class="model-name">${m.name}</div>
          <div class="model-meta">${m.dataset} • Round #${m.round}</div>
        </div>
        <div class="model-status ${m.status}">${m.status === 'training' ? 'Training' : m.status === 'completed' ? 'Completed' : 'Queued'}</div>
      </div>
    `).join('');
  }

  // ===== TASK LIST (Node) =====
  function renderTaskList() {
    const list = document.getElementById('taskList');
    const tasks = generateTasks();
    document.getElementById('taskCount').textContent = `${tasks.length} Tasks`;
    list.innerHTML = tasks.map(t => `
      <div class="task-row">
        <div class="task-num">#${t.id}</div>
        <div class="task-info">
          <div class="task-name">${t.name}</div>
          <div class="task-meta">${t.details}</div>
        </div>
        <div class="task-prog">
          <div class="task-prog-track"><div class="task-prog-bar" style="width:${t.progress}%"></div></div>
          <div class="task-prog-text">${t.progress}%</div>
        </div>
        <div class="task-badge ${t.status === 'completed' ? 'completed' : t.status === 'in-progress' ? 'active' : 'pending'}">
          ${t.status === 'completed' ? 'Done' : t.status === 'in-progress' ? 'Active' : 'Pending'}
        </div>
      </div>
    `).join('');
  }

  // ===== CONTRACT ADDRESSES =====
  function renderContractAddresses() {
    const shorten = (a) => a.slice(0, 6) + '...' + a.slice(-4);
    document.getElementById('taskContractAddr').textContent = shorten(CONTRACTS.taskManager.address);
    document.getElementById('stakeContractAddr').textContent = shorten(CONTRACTS.staking.address);
    document.getElementById('aggregatorContractAddr').textContent = shorten(CONTRACTS.aggregator.address);
  }

  // ===== REWARD DISPLAY =====
  function updateRewardDisplay() {
    document.getElementById('rewardDisplay').textContent = SimState.totalReward.toFixed(3) + ' MON';
    document.getElementById('claimedReward').textContent = SimState.claimedReward.toFixed(3);
    document.getElementById('pendingReward').textContent = SimState.pendingReward.toFixed(3);
    document.getElementById('completedTasks').textContent = SimState.completedTasks;
    document.getElementById('nodeEarned').textContent = SimState.totalReward.toFixed(1) + ' MON';
    document.getElementById('nodeTasks').textContent = SimState.completedTasks;
  }

  // ===== ACCURACY CHART =====
  function buildAccuracyChart() {
    const c = document.getElementById('accuracyChart');
    c.innerHTML = '';
    const max = Math.max(...SimState.accuracyHistory);
    SimState.accuracyHistory.forEach(v => {
      const bar = document.createElement('div');
      bar.className = 'bar';
      bar.style.height = (v / max * 100) + '%';
      c.appendChild(bar);
    });
  }

  // ===== SIMULATION =====
  function startSimulation() {
    simInterval = setInterval(() => {
      SimState.roundProgress += Math.random() * 3 + 0.5;
      if (SimState.roundProgress >= 100) {
        SimState.roundProgress = 0;
        SimState.currentRound++;
        SimState.completedTasks++;
        const d = (Math.random() - 0.3) * 0.8;
        SimState.globalAccuracy = Math.min(99.9, Math.max(70, SimState.globalAccuracy + d));
        SimState.accuracyHistory.push(Math.round(SimState.globalAccuracy));
        if (SimState.accuracyHistory.length > 12) SimState.accuracyHistory.shift();
        const r = Math.random() * 3 + 1;
        SimState.totalReward += r;
        SimState.pendingReward += r;
        const nd = Math.floor(Math.random() * 3) - 1;
        SimState.activeNodes = Math.max(8, SimState.activeNodes + nd);
        renderTaskList();
        buildAccuracyChart();
        updateRewardDisplay();
        showToast('🎉', `Round #${SimState.currentRound - 1} completed! Accuracy: ${SimState.globalAccuracy.toFixed(1)}%`);
      }
      // Update owner view
      document.getElementById('ownerRounds').textContent = SimState.currentRound;
      document.getElementById('ownerAccuracy').textContent = SimState.globalAccuracy.toFixed(1) + '%';
      document.getElementById('trainingPct').textContent = Math.round(SimState.roundProgress) + '%';
      document.getElementById('trainingBar').style.width = SimState.roundProgress + '%';
      document.getElementById('networkNodeCount').textContent = SimState.activeNodes + ' Nodes';
    }, 3000);
  }

  // ===== CANVAS =====
  function initCanvas() {
    canvas = document.getElementById('networkCanvas');
    if (!canvas) return;
    const wrapper = canvas.parentElement;
    canvas.width = wrapper.clientWidth;
    canvas.height = wrapper.clientHeight;
    ctx = canvas.getContext('2d');
    SimState.initNodes(canvas.width, canvas.height);
    canvas.addEventListener('mousemove', onCanvasMove);
    canvas.addEventListener('mouseleave', () => {
      hoveredNode = null;
      document.getElementById('nodeTooltip').classList.remove('visible');
    });
    window.addEventListener('resize', () => {
      canvas.width = wrapper.clientWidth;
      canvas.height = wrapper.clientHeight;
    });
    drawNetwork();
  }

  function drawNetwork() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const nodes = SimState.nodes;
    if (!nodes.length) { animFrameId = requestAnimationFrame(drawNetwork); return; }
    const agg = nodes[0];

    nodes.forEach(n => {
      if (n.isAggregator) return;
      const dx = agg.x - n.x, dy = agg.y - n.y;
      const dist = Math.sqrt(dx*dx + dy*dy);
      const maxD = Math.min(canvas.width, canvas.height) * 0.55;
      if (dist < maxD) {
        ctx.beginPath(); ctx.moveTo(n.x, n.y); ctx.lineTo(agg.x, agg.y);
        ctx.strokeStyle = `rgba(255,171,145,${0.03 + (1 - dist/maxD) * 0.1})`;
        ctx.lineWidth = 0.7; ctx.stroke();
        const t = (Date.now() % 4000) / 4000;
        const p = (t + n.x * 0.001) % 1;
        ctx.beginPath(); ctx.arc(n.x + dx*p, n.y + dy*p, 1.5, 0, Math.PI*2);
        ctx.fillStyle = `rgba(255,171,145,${Math.sin(p * Math.PI) * 0.6})`;
        ctx.fill();
      }
    });

    nodes.forEach(n => {
      if (!n.isAggregator) {
        n.x += n.vx; n.y += n.vy;
        if (n.x < 15 || n.x > canvas.width - 15) n.vx *= -1;
        if (n.y < 15 || n.y > canvas.height - 15) n.vy *= -1;
        n.vx += (Math.random() - 0.5) * 0.015; n.vy += (Math.random() - 0.5) * 0.015;
        n.vx *= 0.998; n.vy *= 0.998;
      } else {
        n.x = canvas.width / 2 + Math.sin(Date.now() * 0.0003) * 4;
        n.y = canvas.height / 2 + Math.cos(Date.now() * 0.0004) * 3;
      }
      const c = DEVICE_TYPES[n.type].color;
      const hov = hoveredNode === n;
      ctx.beginPath(); ctx.arc(n.x, n.y, n.radius, 0, Math.PI*2);
      ctx.fillStyle = hov ? c : c + 'BB'; ctx.fill();
      if (hov) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke(); }
      if (n.isAggregator) {
        const pr = n.radius + 5 + Math.sin(Date.now() * 0.003) * 3;
        ctx.beginPath(); ctx.arc(n.x, n.y, pr, 0, Math.PI*2);
        ctx.strokeStyle = `rgba(255,213,79,${0.25 + Math.sin(Date.now() * 0.003) * 0.15})`;
        ctx.lineWidth = 1; ctx.stroke();
      }
    });
    animFrameId = requestAnimationFrame(drawNetwork);
  }

  function onCanvasMove(e) {
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    hoveredNode = null;
    for (const n of SimState.nodes) {
      if (Math.sqrt((mx-n.x)**2 + (my-n.y)**2) < n.radius + 6) { hoveredNode = n; break; }
    }
    const tt = document.getElementById('nodeTooltip');
    if (hoveredNode) {
      const dt = DEVICE_TYPES[hoveredNode.type];
      document.getElementById('tooltipTitle').textContent = `${dt.icon} ${hoveredNode.name}`;
      document.getElementById('tooltipContent').innerHTML = `
        <div class="tooltip-row"><span class="label">Type:</span><span class="value">${dt.label}</span></div>
        <div class="tooltip-row"><span class="label">Accuracy:</span><span class="value">${hoveredNode.accuracy.toFixed(1)}%</span></div>
        <div class="tooltip-row"><span class="label">Stake:</span><span class="value">${hoveredNode.stake.toFixed(2)} MON</span></div>
        <div class="tooltip-row"><span class="label">Updates:</span><span class="value">${hoveredNode.updates}</span></div>`;
      tt.style.left = (e.clientX + 12) + 'px';
      tt.style.top = (e.clientY + 12) + 'px';
      tt.classList.add('visible');
    } else { tt.classList.remove('visible'); }
  }

  // ===== ACTIVITY =====
  function addInitialActivities() {
    ['tx','model','reward','join','tx','model','join','tx'].forEach(t => addActivity(t));
  }
  function startActivityFeed() {
    activityInterval = setInterval(() => {
      const types = ['tx','model','reward','join','alert'];
      const w = [30,25,15,20,10];
      let r = Math.random() * 100;
      let type = types[4];
      for (let i = 0; i < types.length; i++) { r -= w[i]; if (r <= 0) { type = types[i]; break; } }
      addActivity(type);
    }, 4000);
  }
  function addActivity(type) {
    const feed = document.getElementById('activityFeed');
    const msg = generateActivityMessage(type);
    const time = new Date().toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
    const labels = { tx:'TX', model:'MODEL', reward:'REWARD', join:'JOIN', alert:'ALERT' };
    const el = document.createElement('div');
    el.className = 'act-item';
    el.innerHTML = `<span class="act-time">${time}</span><span class="act-type ${type}">${labels[type]}</span><span class="act-msg">${msg}</span>`;
    feed.insertBefore(el, feed.firstChild);
    while (feed.children.length > 40) feed.removeChild(feed.lastChild);
  }

  // ===== WALLET =====
  window.openWalletModal = () => document.getElementById('walletModal').classList.add('active');
  window.closeWalletModal = () => document.getElementById('walletModal').classList.remove('active');

  window.connectWallet = async function(type) {
    closeWalletModal();
    if (type === 'metamask') {
      if (!window.ethereum) { showToast('⚠️', 'MetaMask not found!'); return; }
      try {
        showToast('🔄', 'Connecting...');
        const accs = await window.ethereum.request({ method: 'eth_requestAccounts' });
        if (!accs?.length) { showToast('❌', 'Access denied.'); return; }
        try { await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: MONAD_TESTNET.chainId }] }); }
        catch (e) {
          if (e.code === 4902) {
            await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [{ chainId: MONAD_TESTNET.chainId, chainName: MONAD_TESTNET.chainName, nativeCurrency: MONAD_TESTNET.currency, rpcUrls: [MONAD_TESTNET.rpcUrl], blockExplorerUrls: [MONAD_TESTNET.blockExplorer] }] });
          }
        }
        provider = new ethers.BrowserProvider(window.ethereum);
        signer = await provider.getSigner();
        const addr = await signer.getAddress();
        SimState.walletConnected = true; SimState.walletAddress = addr;
        const short = addr.slice(0,6) + '...' + addr.slice(-4);
        document.getElementById('walletBtnText').textContent = short;
        document.getElementById('walletBtn').onclick = disconnectWallet;
        document.getElementById('networkStatus').classList.remove('disconnected');
        document.getElementById('networkStatusText').textContent = 'Monad Testnet';
        try { const b = await provider.getBalance(addr); showToast('✅', `Connected! ${parseFloat(ethers.formatEther(b)).toFixed(4)} MON`); }
        catch { showToast('✅', `Connected: ${short}`); }
        addActivity('join');
        window.ethereum.on('accountsChanged', a => { if (!a.length) disconnectWallet(); else document.getElementById('walletBtnText').textContent = a[0].slice(0,6)+'...'+a[0].slice(-4); });
        window.ethereum.on('chainChanged', () => location.reload());
      } catch (e) { showToast('❌', 'Connection failed.'); console.error(e); }
    } else { showToast('ℹ️', `${type} support coming soon.`); }
  };

  function disconnectWallet() {
    SimState.walletConnected = false; SimState.walletAddress = null; provider = null; signer = null;
    document.getElementById('walletBtnText').textContent = 'Connect Wallet';
    document.getElementById('walletBtn').onclick = openWalletModal;
    document.getElementById('networkStatus').classList.add('disconnected');
    document.getElementById('networkStatusText').textContent = 'Disconnected';
    showToast('ℹ️', 'Wallet disconnected.');
  }

  // ===== CLAIM =====
  window.claimRewards = async function() {
    if (!SimState.walletConnected) { showToast('⚠️', 'Connect wallet first!'); openWalletModal(); return; }
    if (SimState.pendingReward <= 0) { showToast('ℹ️', 'No pending rewards.'); return; }
    const btn = document.getElementById('claimBtn');
    btn.disabled = true; btn.textContent = 'Processing...';
    try {
      showToast('🔄', 'Submitting claim...');
      await new Promise(r => setTimeout(r, 2000));
      const amt = SimState.pendingReward;
      SimState.claimedReward += amt; SimState.pendingReward = 0;
      updateRewardDisplay();
      document.getElementById('rewardBadge').textContent = 'Claimed';
      document.getElementById('rewardBadge').className = 'badge green';
      showToast('✅', `${amt.toFixed(3)} MON claimed!`);
      addActivity('reward');
    } catch (e) { showToast('❌', 'Claim failed.'); }
    finally { btn.disabled = false; btn.textContent = 'Claim Rewards'; }
  };

  // ===== TOAST =====
  function showToast(icon, msg) {
    const c = document.getElementById('toastContainer');
    const t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = `<span class="toast-icon">${icon}</span><span class="toast-msg">${msg}</span>`;
    c.appendChild(t);
    setTimeout(() => { if (t.parentElement) t.remove(); }, 5000);
  }

  window.addEventListener('beforeunload', () => {
    if (animFrameId) cancelAnimationFrame(animFrameId);
    if (simInterval) clearInterval(simInterval);
    if (activityInterval) clearInterval(activityInterval);
  });
})();
