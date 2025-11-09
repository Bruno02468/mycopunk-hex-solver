// app.js — piece editor, collection UI, and greedy solver
// two-space indentation, keep lines reasonably short

(function(){
  'use strict';

  const PALETTE = {
    magenta: 'rgb(254,99,255)',
    blue: 'rgb(91,203,252)',
    orange: 'rgb(253,173,59)',
    green: 'rgb(63,244,119)'
  };

  let pieces = [];
  let pieceIdSeq = 1;
  let boardGrid = null;
  let renderer = null;

  // Solver state
  let solverRunning = false;
  let solverShouldStop = false;
  let workers = [];
  let topSolutions = []; // All solutions tied for best coverage
  let currentSolutionIndex = 0; // Current solution being displayed

  // DOM refs
  const editorGridEl = document.getElementById('editor-grid');
  const colorInputs = document.querySelectorAll('.color-choice');
  const addPieceBtn = document.getElementById('add-piece');
  const piecesList = document.getElementById('pieces-list');
  const boardW = document.getElementById('board-w');
  const boardH = document.getElementById('board-h');
  const solveBtn = document.getElementById('solve');
  const clearBtn = document.getElementById('clear-solution');
  const boardContainer = document.getElementById('board-container');
  const highContrastCheckbox = document.getElementById('high-contrast');
  const allowRotationsCheckbox = document.getElementById('allow-rotations');
  const solverStatsEl = document.getElementById('solver-stats');
  const statsStatus = document.getElementById('stats-status');
  const statsCount = document.getElementById('stats-count');
  const statsCoverage = document.getElementById('stats-coverage');
  const statsPieces = document.getElementById('stats-pieces');
  const statsTime = document.getElementById('stats-time');
  const solutionCyclingEl = document.getElementById('solution-cycling');
  const solutionCounter = document.getElementById('solution-counter');
  const prevSolutionBtn = document.getElementById('prev-solution');
  const nextSolutionBtn = document.getElementById('next-solution');
  // fixed hex size for all grids
  const HEX_SIZE = 24;
  const PREVIEW_SIZE = 8;
  // editor grid dimensions (change these to alter piece editor and previews)
  const EDITOR_GRID_W = 7;
  const EDITOR_GRID_H = 5;

  // no unused vars

  function init(){
    buildEditor();
    addPieceBtn.addEventListener('click', onAddPiece);
    solveBtn.addEventListener('click', onSolve);
    clearBtn.addEventListener('click', onClear);
    highContrastCheckbox.addEventListener('change', () => {
      renderBoard();
      renderPiecesList();
    });
    prevSolutionBtn.addEventListener('click', showPreviousSolution);
    nextSolutionBtn.addEventListener('click', showNextSolution);
    boardW.value = 9;
    boardH.value = 9;
    // no hex size input, fixed size
    colorInputs.forEach(inp => {
      inp.addEventListener('change', () => {
        updateEditorCellsToSelectedColor();
        refreshEditorUI();
      });
    });
  // When color picker changes, update all selected cells to the new color
  function updateEditorCellsToSelectedColor() {
    if (!editorGrid) return;
    const newColor = PALETTE[getSelectedColor()];
    editorGrid.forEach(cell => {
      if (cell.data && cell.data.color && cell.data.color !== newColor) {
        editorGrid.set(cell.hex, { color: newColor });
      }
    });
  }
    renderPiecesList();
  }

  let editorGrid = null;
  let editorRenderer = null;

  // editor UI - use a hex grid for editing
  function buildEditor(){
    editorGridEl.innerHTML = '';
  // create an editor grid with configurable size
  editorGrid = new HexGrid.HexGrid();
  editorGrid.generateRect(EDITOR_GRID_W, EDITOR_GRID_H, 0, 0);
    const size = 20; // smaller hex size for editor
    editorRenderer = new HexGrid.Renderer(editorGridEl, editorGrid, {
      size,
      spacing: 2, // set your desired spacing in px (match board if needed)
      enableSelection: false
    });
    // add our own click handler
    const cells = editorGridEl.querySelectorAll('.hexgrid-cell');
    cells.forEach((el)=>{
      const q = +el.dataset.q;
      const r = +el.dataset.r;
      const hex = new HexGrid.Hex(q, r);
      el.addEventListener('click', ()=> onToggleEditorCell(hex));
    });
    // update hex shapes to flat-top only (renderer handles spacing and placement)
    cells.forEach((el)=>{
      el.style.clipPath = 'polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)';
      el.style.width = (size * 2) + 'px';
      el.style.height = (size * Math.sqrt(3)) + 'px';
    });
  }

  function onToggleEditorCell(hex){
    const key = hex.key();
    const cell = editorGrid.get(hex);
    if (!cell) return;
    const color = cell.data && cell.data.color ? null : PALETTE[getSelectedColor()];
    editorGrid.set(hex, color ? {color} : null);
    refreshEditorUI(); // refresh after each click
  }

  function refreshEditorUI(){
    if (!editorGrid || !editorRenderer) return;
    editorGrid.forEach((cell)=>{
      if (cell.data && cell.data.color) {
        // preserve the actual color stored on the cell instead of forcing the
        // currently-selected palette color. Previously this overwrote editor
        // cell colors when the user changed the selected color, which could
        // lead to pieces being captured with wrong/mutated colors.
        editorRenderer.updateCell(cell.hex, {color: cell.data.color});
      } else {
        editorRenderer.updateCell(cell.hex, null);
      }
    });
  }

  function getSelectedColor(){
    for (const inp of colorInputs){
      if (inp.checked) return inp.value;
    }
    return 'magenta';
  }

  function onAddPiece(){
    const cells = [];
    editorGrid.forEach((cell)=>{
      if (cell.data && cell.data.color){
        cells.push(cell.hex);
      }
    });
    if (cells.length === 0) return;
    // Normalize cells to offsets centered on piece so rotation works
    // Convert odd-q to axial, find center in axial space, convert back
    const n = cells.length;
    let sumQ = 0, sumR = 0, sumS = 0;
    cells.forEach(h => {
      // Convert to axial
      const axial_q = h.q;
      const axial_r = h.r - (h.q - (h.q & 1)) / 2;
      sumQ += axial_q;
      sumR += axial_r;
      sumS += (-axial_q - axial_r);
    });
    const aq = sumQ / n, ar = sumR / n, as = sumS / n;
    // cube-round in axial space
    let rx = Math.round(aq), ry = Math.round(ar), rz = Math.round(as);
    const x_diff = Math.abs(rx - aq), y_diff = Math.abs(ry - ar), z_diff = Math.abs(rz - as);
    if (x_diff > y_diff && x_diff > z_diff) rx = -ry - rz;
    else if (y_diff > z_diff) ry = -rx - rz;
    else rz = -rx - ry;
    // Convert center back to odd-q offset
    const centerQ = rx;
    const centerR = ry + (rx - (rx & 1)) / 2;
    // Store offsets relative to center (in odd-q offset coords)
    const offsets = cells.map(h => HexGrid.subtract(h, new HexGrid.Hex(centerQ, centerR)));
    const colorKey = getSelectedColor();
    const piece = {
      id: pieceIdSeq++,
      colorKey: colorKey,
      color: PALETTE[colorKey],
      cells: offsets
    };
    pieces.push(piece);
    saveCollection();
    editorGrid.clearData();
    refreshEditorUI();
    renderPiecesList();
  }

  function renderPiecesList(){
    piecesList.innerHTML = '';
    pieces.forEach((p, i)=>{
      const li = document.createElement('li');
      li.style.display = 'flex';
      li.style.alignItems = 'center';
      li.style.gap = '8px';
      // tiny preview
      const prevDiv = document.createElement('div');
      prevDiv.style.display = 'inline-block';
        prevDiv.style.width = (PREVIEW_SIZE * EDITOR_GRID_W) + 'px';
        prevDiv.style.height = (PREVIEW_SIZE * EDITOR_GRID_H) + 'px';
      prevDiv.style.position = 'relative';
      li.appendChild(prevDiv);
      renderPiecePreview(prevDiv, p);
      // id label
      const label = document.createElement('div');
      label.textContent = `#${p.id}`;
      li.appendChild(label);
      // controls
      const up = document.createElement('button');
      up.textContent = '↑';
      up.addEventListener('click', ()=> movePieceUp(i));
      li.appendChild(up);
      const down = document.createElement('button');
      down.textContent = '↓';
      down.addEventListener('click', ()=> movePieceDown(i));
      li.appendChild(down);
      // clone button
      const cloneBtn = document.createElement('button');
      cloneBtn.textContent = '⧉';
      cloneBtn.title = 'clone piece';
      cloneBtn.addEventListener('click', ()=> clonePiece(i));
      li.appendChild(cloneBtn);
      const del = document.createElement('button');
      del.textContent = '✖';
      del.addEventListener('click', ()=> removePiece(i));
      li.appendChild(del);
      piecesList.appendChild(li);
    });
  }

  function clonePiece(i){
    const orig = pieces[i];
    const newPiece = {
      id: pieceIdSeq++,
      colorKey: orig.colorKey,
      color: orig.color,
      cells: orig.cells.map(h => new HexGrid.Hex(h.q, h.r))
    };
    pieces.splice(i+1, 0, newPiece);
    saveCollection();
    renderPiecesList();
  }

  function renderPiecePreview(container, piece){
    container.innerHTML = '';
    if (!piece.cells || piece.cells.length === 0) return;

    // Find bounds in odd-q space
    let minQ = Infinity, minR = Infinity, maxQ = -Infinity, maxR = -Infinity;
    piece.cells.forEach(h => {
      minQ = Math.min(minQ, h.q);
      minR = Math.min(minR, h.r);
      maxQ = Math.max(maxQ, h.q);
      maxR = Math.max(maxR, h.r);
    });

    // Shift so minimum is at (0,0) using proper odd-q subtraction
    const offset = new HexGrid.Hex(minQ, minR);
    const previewHexes = piece.cells.map(h => HexGrid.subtract(h, offset));

    // Find new bounds after shift
    let maxQ2 = -Infinity, maxR2 = -Infinity;
    previewHexes.forEach(h => {
      maxQ2 = Math.max(maxQ2, h.q);
      maxR2 = Math.max(maxR2, h.r);
    });

    const hexW = PREVIEW_SIZE * 2;
    const hexH = PREVIEW_SIZE * Math.sqrt(3);
    // Compute bounding box using odd-q pixel formula
    const maxX = PREVIEW_SIZE * 1.5 * maxQ2;
    const width = maxX + hexW;
    let maxY = 0;
    previewHexes.forEach(h => {
      const y = PREVIEW_SIZE * Math.sqrt(3) * h.r + (Math.abs(h.q) % 2) * (PREVIEW_SIZE * Math.sqrt(3)/2);
      if (y > maxY) maxY = y;
    });
    const height = maxY + hexH;
    container.style.position = 'relative';
  container.style.width = PREVIEW_SIZE * EDITOR_GRID_W * Math.sqrt(3) + 'px';
    container.style.height = height + 'px';
    // Render hexes
    // Use high contrast color if enabled
    let previewColor = piece.color;
    if (typeof highContrastCheckbox !== 'undefined' && highContrastCheckbox.checked) {
      // Try to match the color logic from pieceColorVariations
      const idx = pieces.findIndex(p => p.id === piece.id);
      if (idx !== -1) {
        // Use the same highContrastColor function as in board rendering
        const base_palette = [
          "#FF6B6B", "#4ECDC4", "#FFD93D", "#1A535C", "#FF9F1C",
          "#5C7AEA", "#6BCB77", "#C86BFA", "#F06595", "#00BBF9"
        ];
        function highContrastColor(i, n) {
          if (i < base_palette.length) return base_palette[i];
          const hue = (360 / n) * i;
          const lightness = 65;
          const chroma = 70;
          return `lch(${lightness}% ${chroma} ${hue})`;
        }
        previewColor = highContrastColor(idx, pieces.length);
      }
    }
    previewHexes.forEach(h => {
      // Flat-top: odd columns offset down by half hex height
      const x = PREVIEW_SIZE * 1.5 * h.q;
      const y = PREVIEW_SIZE * Math.sqrt(3) * h.r + (Math.abs(h.q) % 2) * (PREVIEW_SIZE * Math.sqrt(3)/2);
      const hex = document.createElement('div');
      hex.style.position = 'absolute';
      hex.style.width = hexW + 'px';
      hex.style.height = hexH + 'px';
      hex.style.left = x + 'px';
      hex.style.top = y + 'px';
      hex.style.background = previewColor;
      hex.style.clipPath = 'polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)';
      hex.style.border = '1px solid #aaa';
      container.appendChild(hex);
    });
  }

  function movePieceUp(i){
    if (i <= 0) return;
    const tmp = pieces[i-1];
    pieces[i-1] = pieces[i];
    pieces[i] = tmp;
    saveCollection();
    renderPiecesList();
  }
  function movePieceDown(i){
    if (i >= pieces.length-1) return;
    const tmp = pieces[i+1];
    pieces[i+1] = pieces[i];
    pieces[i] = tmp;
    saveCollection();
    renderPiecesList();
  }
  function removePiece(i){
    pieces.splice(i, 1);
    // Renumber all pieces to have contiguous ids starting from 1
    pieces.forEach((p, idx) => { p.id = idx + 1; });
    pieceIdSeq = pieces.length + 1;
    saveCollection();
    renderPiecesList();
    renderBoard(); // update board numbers if needed
  }

  // solver - backtracking algorithm to find optimal coverage
  async function onSolve(){
    if (solverRunning) {
      // Stop the solver
      solverShouldStop = true;
      workers.forEach(w => w.postMessage({ type: 'STOP' }));
      workers.forEach(w => w.terminate());
      workers = [];
      solveBtn.textContent = 'solve';
      statsStatus.textContent = 'stopped by user';
      solverRunning = false;
      return;
    }

    await solveWithWorkers();
  }

  // Web Worker-based parallel solver
  async function solveWithWorkers() {
    solverRunning = true;
    solverShouldStop = false;
    solveBtn.textContent = 'stop';
    solverStatsEl.style.display = 'block';
    statsStatus.textContent = 'running (parallel)...';
    solutionCyclingEl.style.display = 'none';
    topSolutions = [];
    currentSolutionIndex = 0;

    const w = Math.max(1, parseInt(boardW.value, 10) || 1);
    const h = Math.max(1, parseInt(boardH.value, 10) || 1);
    boardGrid = new HexGrid.HexGrid();
    boardGrid.generateRect(w, h);

    console.log('Starting parallel backtracking solver...');
    const startTime = Date.now();
    const boardSize = w * h;

    // Build linear index mapping for board cells and neighbor lists
    const boardCells = boardGrid.getCellsArray().map(c => c.hex);
    const cellIndexMap = new Map();
    boardCells.forEach((hex, idx) => cellIndexMap.set(hex.key(), idx));

    // Precompute neighbor indices for each cell (array of arrays)
    const neighbors = boardCells.map((hex) => {
      return boardGrid.neighbors(hex).map(n => cellIndexMap.get(n.hex.key()));
    });

    // Precompute placements (use integer indices for targets and anchor index)
    const piecePlacements = pieces.map((piece, pi) => {
      const placements = [];
      const rotLimit = (allowRotationsCheckbox && !allowRotationsCheckbox.checked) ? 1 : 6;
      for (let rot = 0; rot < rotLimit; rot++) {
        boardGrid.forEach((cell) => {
          const anchor = cell.hex;
          let valid = true;
          const targets = [];
          for (const off of piece.cells) {
            const ro = HexGrid.rotate(off, rot);
            const target = HexGrid.add(anchor, ro);
            if (!boardGrid.has(target)) {
              valid = false;
              break;
            }
            const idx = cellIndexMap.get(target.key());
            targets.push(idx);
          }
          if (valid) {
            placements.push({
              pieceIdx: pi,
              pieceId: piece.id,
              anchorIdx: cellIndexMap.get(anchor.key()),
              rot,
              targets
            });
          }
        });
      }
      return placements;
    });

    // Static MRV ordering: sort pieces by number of placements (fewest placements first)
    const pieceOrder = pieces.map((p, i) => i).sort((a, b) => {
      return piecePlacements[a].length - piecePlacements[b].length;
    });

    // Determine number of workers (use CPU core count if available)
    const numWorkers = navigator.hardwareConcurrency || 4;
    console.log(`Using ${numWorkers} workers`);

    // Global best tracking
    let bestCoverage = 0;
    let totalSearchCount = 0;
    let completedWorkers = 0;
    let workerSearchCounts = new Array(numWorkers).fill(0);

    function updateStats() {
      const elapsed = (Date.now() - startTime) / 1000;
      const statesPerSecond = elapsed > 0 ? Math.round(totalSearchCount / elapsed) : 0;

      statsCount.textContent = totalSearchCount.toLocaleString() + ` (${statesPerSecond.toLocaleString()}/s)`;
      statsCoverage.textContent = `${bestCoverage}/${boardSize}`;
      const currentSolution = topSolutions[currentSolutionIndex];
      statsPieces.textContent = currentSolution ? `${currentSolution.length}/${pieces.length}` : `0/${pieces.length}`;
      statsTime.textContent = elapsed.toFixed(1);
    }

    function updateSolutionCounter() {
      if (topSolutions.length > 0) {
        solutionCounter.textContent = `${currentSolutionIndex + 1} of ${topSolutions.length}`;
        solutionCyclingEl.style.display = topSolutions.length > 1 ? 'block' : 'none';
      }
    }

    function updateBoardDisplay() {
      if (topSolutions.length === 0) return;
      const solution = topSolutions[currentSolutionIndex];
      if (!solution) return;

      boardGrid.forEach(cell => {
        boardGrid.set(cell.hex, null);
      });

      for (const placement of solution) {
        const piece = pieces.find(p => p.id === placement.piece);
        const anchor = new HexGrid.Hex(placement.anchor.q, placement.anchor.r);

        for (const off of piece.cells) {
          const ro = HexGrid.rotate(off, placement.rot);
          const target = HexGrid.add(anchor, ro);
          boardGrid.set(target, { color: piece.color });
        }
      }

      saveBoardConfig(w, h, solution);
      renderBoard();
      updateSolutionCounter();
    }

    function getSolutionCellSignature(solution) {
      // Create a signature based on which cells are covered by which piece
      const cellToPiece = [];

      for (const placement of solution) {
        const piece = pieces.find(p => p.id === placement.piece);
        if (!piece) continue;
        const anchor = new HexGrid.Hex(placement.anchor.q, placement.anchor.r);

        for (const off of piece.cells) {
          const ro = HexGrid.rotate(off, placement.rot);
          const target = HexGrid.add(anchor, ro);
          const cellIdx = cellIndexMap.get(target.key());
          if (cellIdx !== undefined) {
            cellToPiece.push([cellIdx, placement.piece]);
          }
        }
      }

      // Sort by cell index to create canonical ordering
      cellToPiece.sort((a, b) => a[0] - b[0]);
      return JSON.stringify(cellToPiece);
    }

    // Pack placements into flat typed arrays to reduce structured-clone overhead
    const numPieces = piecePlacements.length;
    let numPlacements = 0;
    let totalTargets = 0;
    for (let pi = 0; pi < numPieces; pi++) {
      numPlacements += piecePlacements[pi].length;
      for (let pl of piecePlacements[pi]) totalTargets += pl.targets.length;
    }

    // placementsMeta: [ pieceIdx, pieceId, anchorIdx, rot, targetsStart, targetsLen ] per placement
    const placementsMeta = new Int32Array(numPlacements * 6);
    const placementsTargets = new Int32Array(totalTargets);
    const piecePlacementStart = new Int32Array(numPieces);
    const piecePlacementCount = new Int32Array(numPieces);

    let placementIdx = 0;
    let targetCursor = 0;
    for (let pi = 0; pi < numPieces; pi++) {
      piecePlacementStart[pi] = placementIdx;
      const list = piecePlacements[pi];
      piecePlacementCount[pi] = list.length;
      for (let j = 0; j < list.length; j++) {
        const pl = list[j];
        const base = placementIdx * 6;
        placementsMeta[base + 0] = pl.pieceIdx;
        placementsMeta[base + 1] = pl.pieceId;
        placementsMeta[base + 2] = pl.anchorIdx;
        placementsMeta[base + 3] = pl.rot;
        placementsMeta[base + 4] = targetCursor;
        placementsMeta[base + 5] = pl.targets.length;
        for (let t = 0; t < pl.targets.length; t++) placementsTargets[targetCursor++] = pl.targets[t];
        placementIdx++;
      }
    }

    // Create work packages: distribute first-piece placements across workers
    const firstPieceIdx = pieceOrder[0];
    const firstPieceStart = piecePlacementStart[firstPieceIdx];
    const firstPieceCount = piecePlacementCount[firstPieceIdx];
    const placementsPerWorker = Math.ceil(firstPieceCount / numWorkers);

    // Spawn workers
    for (let i = 0; i < numWorkers && i * placementsPerWorker < firstPieceCount; i++) {
      const worker = new Worker('./solver-worker.js');
      workers.push(worker);

      const startIdx = i * placementsPerWorker;
      const endIdx = Math.min(startIdx + placementsPerWorker, firstPieceCount);
      const assignedPlacementIndices = new Int32Array(Math.max(0, endIdx - startIdx));
      for (let k = startIdx; k < endIdx; k++) assignedPlacementIndices[k - startIdx] = firstPieceStart + k;

      worker.onmessage = function(e) {
        const { type, data } = e.data;

        if (type === 'PROGRESS') {
          workerSearchCounts[i] = data.searchCount;
          totalSearchCount = workerSearchCounts.reduce((sum, count) => sum + count, 0);
          updateStats();
        } else if (type === 'COMPLETE') {
          workerSearchCounts[i] = data.searchCount;
          totalSearchCount = workerSearchCounts.reduce((sum, count) => sum + count, 0);
          completedWorkers++;
          console.log(`Worker ${data.workerId} completed (searched ${data.searchCount} states). ${completedWorkers}/${workers.length} done`);

          // Process solutions from this worker
          if (data.coverage > bestCoverage) {
            // This worker found better coverage - replace all solutions
            bestCoverage = data.coverage;
            topSolutions = data.solutions || [];
            currentSolutionIndex = 0;
            console.log(`Worker ${data.workerId} found best coverage! Coverage: ${bestCoverage}, ${topSolutions.length} solution(s)`);
          } else if (data.coverage === bestCoverage && data.solutions) {
            // Same coverage - merge solutions with proper deduplication
            const existingSignatures = new Set(topSolutions.map(s => getSolutionCellSignature(s)));

            for (const newSol of data.solutions) {
              const signature = getSolutionCellSignature(newSol);
              if (!existingSignatures.has(signature)) {
                existingSignatures.add(signature);
                topSolutions.push(newSol);
              }
            }
            console.log(`Worker ${data.workerId} added solutions. Total: ${topSolutions.length}`);
          }

          if (completedWorkers >= workers.length) {
            // All workers done
            const elapsed = Date.now() - startTime;
            console.log(`All workers complete! Searched ${totalSearchCount} states in ${elapsed}ms`);
            console.log(`Best solution: ${bestCoverage} cells with ${topSolutions.length} solution(s) tied for top coverage`);

            updateStats();
            updateSolutionCounter();
            statsStatus.textContent = solverShouldStop ? 'stopped' : 'complete';
            solverRunning = false;
            solveBtn.textContent = 'solve';

            workers.forEach(w => w.terminate());
            workers = [];

            if (topSolutions.length > 0) {
              saveBoardConfig(w, h, topSolutions[currentSolutionIndex]);
              updateBoardDisplay();
            } else {
              renderBoard();
            }
          }
        }
      };      worker.onerror = function(err) { console.error(`Worker ${i} error:`, err); };

      // IMPORTANT: Each worker gets a different subset of first-piece placements to explore
      console.log(`Worker ${i} assigned ${assignedPlacementIndices.length} initial placements (${startIdx}-${endIdx-1})`);

      worker.postMessage({
        type: 'START',
        data: {
          pieces: pieces.map(p => ({ id: p.id, size: p.cells.length })),
          boardSize,
          pieceOrder,
          workerId: i,
          boardCells: boardCells.map(h => ({ q: h.q, r: h.r })),
          neighbors,
          // packed arrays
          placementsMeta,
          placementsTargets,
          piecePlacementStart,
          piecePlacementCount,
          assignedPlacementIndices,
          initialBestCoverage: bestCoverage
        }
      });
    }
  }

  function showPreviousSolution() {
    if (topSolutions.length === 0) return;
    currentSolutionIndex = (currentSolutionIndex - 1 + topSolutions.length) % topSolutions.length;
    const w = parseInt(boardW.value, 10) || 9;
    const h = parseInt(boardH.value, 10) || 9;
    saveBoardConfig(w, h, topSolutions[currentSolutionIndex]);
    loadAndRenderCurrentSolution();
  }

  function showNextSolution() {
    if (topSolutions.length === 0) return;
    currentSolutionIndex = (currentSolutionIndex + 1) % topSolutions.length;
    const w = parseInt(boardW.value, 10) || 9;
    const h = parseInt(boardH.value, 10) || 9;
    saveBoardConfig(w, h, topSolutions[currentSolutionIndex]);
    loadAndRenderCurrentSolution();
  }

  function loadAndRenderCurrentSolution() {
    if (topSolutions.length === 0 || !topSolutions[currentSolutionIndex]) return;

    const solution = topSolutions[currentSolutionIndex];
    boardGrid.forEach(cell => {
      boardGrid.set(cell.hex, null);
    });

    for (const placement of solution) {
      const piece = pieces.find(p => p.id === placement.piece);
      if (!piece) continue;
      const anchor = new HexGrid.Hex(placement.anchor.q, placement.anchor.r);

      for (const off of piece.cells) {
        const ro = HexGrid.rotate(off, placement.rot);
        const target = HexGrid.add(anchor, ro);
        if (boardGrid.has(target)) {
          boardGrid.set(target, { color: piece.color });
        }
      }
    }

    solutionCounter.textContent = `${currentSolutionIndex + 1} of ${topSolutions.length}`;
    renderBoard();
  }

  function onClear(){
    if (!boardGrid) return;
    boardGrid.clearData();
    topSolutions = [];
    currentSolutionIndex = 0;
    solutionCyclingEl.style.display = 'none';
    saveBoardConfig(boardW.value, boardH.value, []);
    renderBoard();
  }

  function renderBoard(){
    if (!boardGrid) return;
    boardContainer.innerHTML = '';
    const opt = {
      size: HEX_SIZE,
      showCoords: false,
      spacing: 0,
    };
    renderer = new HexGrid.Renderer(boardContainer, boardGrid, opt);
    // force flat-top hex shape for all board hexes
    const cells = boardContainer.querySelectorAll('.hexgrid-cell');
    cells.forEach((el)=>{
      el.style.clipPath = 'polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)';
      el.style.width = (HEX_SIZE * 2) + 'px';
      el.style.height = (HEX_SIZE * Math.sqrt(3)) + 'px';
      // ensure hex cells render above the SVG overlay
      el.style.zIndex = 110;
    });

    // Add piece number label to each placed piece and draw links between numbered hexes
    // Build a map from cell key to piece id and also draw per-piece polylines
    const pieceMap = new Map();
    if (Array.isArray(boardGrid) || typeof boardGrid !== 'object') return;
    // Find the solution from localStorage (or reconstruct from boardGrid)
    let solution = [];
    try {
      const d = JSON.parse(localStorage.getItem('hex_board'));
      if (d && Array.isArray(d.solution)) solution = d.solution;
    } catch(e) {}

    // Helper functions for RGB <-> HSL conversion
    function rgbToHsl(r, g, b) {
      r /= 255; g /= 255; b /= 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      let h, s, l = (max + min) / 2;

      if (max === min) {
        h = s = 0; // achromatic
      } else {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
          case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
          case g: h = ((b - r) / d + 2) / 6; break;
          case b: h = ((r - g) / d + 4) / 6; break;
        }
      }
      return [h * 360, s * 100, l * 100];
    }

    function hslToRgb(h, s, l) {
      h /= 360; s /= 100; l /= 100;
      let r, g, b;

      if (s === 0) {
        r = g = b = l; // achromatic
      } else {
        const hue2rgb = (p, q, t) => {
          if (t < 0) t += 1;
          if (t > 1) t -= 1;
          if (t < 1/6) return p + (q - p) * 6 * t;
          if (t < 1/2) return q;
          if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
          return p;
        };
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        r = hue2rgb(p, q, h + 1/3);
        g = hue2rgb(p, q, h);
        b = hue2rgb(p, q, h - 1/3);
      }
      return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
    }

    // Generate color variations for each piece based on their base color
    // Group pieces by base color to create variations
    const colorGroups = {};
    solution.forEach(s => {
      const piece = pieces.find(p => p.id === s.piece);
      if (!piece) return;
      if (!colorGroups[piece.color]) {
        colorGroups[piece.color] = [];
      }
      colorGroups[piece.color].push(s.piece);
    });

    // Create color variations for each piece
    const pieceColorVariations = {};
    const isHighContrast = highContrastCheckbox.checked;


    const base_palette = [
      "#FF6B6B", // red
      "#4ECDC4", // turquoise
      "#FFD93D", // yellow
      "#1A535C", // teal
      "#FF9F1C", // orange
      "#5C7AEA", // periwinkle
      "#6BCB77", // green
      "#C86BFA", // violet
      "#F06595", // pink
      "#00BBF9"  // light blue
    ]

    function highContrastColor(i, n) {
      if (i < base_palette.length) {
        return base_palette[i]
      }
      const hue = (360 / n) * i
      const lightness = 65
      const chroma = 70
      return `lch(${lightness}% ${chroma} ${hue})`
    }

    // Assign each piece a unique high-contrast color if enabled
    if (isHighContrast) {
      pieces.forEach((p, i) => {
        pieceColorVariations[p.id] = highContrastColor(i, pieces.length);
      });
    } else {
      // Not high-contrast: use base color for all
      pieces.forEach(p => {
        pieceColorVariations[p.id] = p.color;
      });
    }

    // For each solution placement, mark the cells with varied colors
    solution.forEach(s => {
      const piece = pieces.find(p => p.id === s.piece);
      if (!piece) return;
      const variedColor = pieceColorVariations[piece.id] || piece.color;
      piece.cells.forEach(off => {
        const ro = HexGrid.rotate(off, s.rot);
        const target = HexGrid.add(new HexGrid.Hex(s.anchor.q, s.anchor.r), ro);
        pieceMap.set(target.key(), piece.id);

        // Apply the varied color to the cell
        const cell = boardGrid.get(target);
        if (cell && cell.data) {
          const el = boardContainer.querySelector(`.hexgrid-cell[data-q="${target.q}"][data-r="${target.r}"]`);
          if (el) {
            el.style.backgroundColor = variedColor;
          }
        }
      });
    });

    // Add number label to each cell if it belongs to a piece
    cells.forEach((el)=>{
      const q = +el.dataset.q;
      const r = +el.dataset.r;
      const key = q + ',' + r;
      if (pieceMap.has(key)) {
        const num = pieceMap.get(key);
        let label = el.querySelector('.piece-num-label');
        if (!label) {
          label = document.createElement('div');
          label.className = 'piece-num-label';
          el.appendChild(label);
        }
        label.textContent = num;
        label.style.position = 'absolute';
        label.style.left = '50%';
        label.style.top = '50%';
        label.style.transform = 'translate(-50%,-50%)';
        label.style.fontWeight = 'bold';
        label.style.fontSize = '16px';
        label.style.color = '#fff';
        label.style.textShadow = '0 0 2px #000, 0 0 2px #000, 1px 1px 2px #000, -1px -1px 2px #000';
        label.style.pointerEvents = 'none';
        label.style.userSelect = 'none';
        // ensure label sits above overlay
        label.style.zIndex = 200;
      }
    });

      // verbose diagnostics: log mapping between DOM cells, boardGrid data and pieceMap
      try {
        console.groupCollapsed('renderBoard: cell mapping');
        cells.forEach((el)=>{
          const q = +el.dataset.q;
          const r = +el.dataset.r;
          const key = q+','+r;
          const cell = boardGrid.get(new HexGrid.Hex(q, r));
          const bg = (cell && cell.data && cell.data.color) ? cell.data.color : null;
          const pm = pieceMap.has(key) ? pieceMap.get(key) : null;
          console.log('cell', key, 'dom-bg', getComputedStyle(el).backgroundColor, 'grid-bg', bg, 'pieceMap', pm);
        });
        console.groupEnd();
        console.log('renderBoard: pieceMap entries:', [...pieceMap.entries()]);
      } catch(e) { console.error(e); }

    // Create an SVG overlay under the hex cells to draw links for each piece
    // Remove existing overlay if present
    let existing = boardContainer.querySelector('#piece-links-overlay');
    if (existing) existing.remove();
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.id = 'piece-links-overlay';
    svg.setAttribute('width', boardContainer.clientWidth);
    svg.setAttribute('height', boardContainer.clientHeight);
  svg.style.position = 'absolute';
  svg.style.left = '0';
  svg.style.top = '0';
  svg.style.pointerEvents = 'none';
  svg.style.zIndex = 50; // make it sit below hexes/labels
  // append overlay
  boardContainer.appendChild(svg);

    // For each placed piece, compute ordered centers and draw a polyline
    solution.forEach(s => {
      const piece = pieces.find(p => p.id === s.piece);
      if (!piece) return;
      const cellsWithCenters = [];
      piece.cells.forEach(off => {
        const ro = HexGrid.rotate(off, s.rot);
        const target = HexGrid.add(new HexGrid.Hex(s.anchor.q, s.anchor.r), ro);
        const sel = boardContainer.querySelector(`.hexgrid-cell[data-q="${target.q}"][data-r="${target.r}"]`);
        if (sel) {
          const rect = sel.getBoundingClientRect();
          const parentRect = boardContainer.getBoundingClientRect();
          const cx = rect.left - parentRect.left + rect.width/2;
          const cy = rect.top - parentRect.top + rect.height/2;
          cellsWithCenters.push({hex: target, center: [cx, cy]});
        }
      });
      if (cellsWithCenters.length >= 1) {
        // Build adjacency graph for the piece's hexes using hex directions
        const hexesInPiece = new Map();
        cellsWithCenters.forEach((cell, idx) => {
          hexesInPiece.set(cell.hex.key(), idx);
        });
        const hexDirections = [
          {q: 1, r: 0}, {q: 1, r: -1}, {q: 0, r: -1},
          {q: -1, r: 0}, {q: -1, r: 1}, {q: 0, r: 1}
        ];
        const adjacencyMap = new Map();
        cellsWithCenters.forEach((cell, idx) => {
          const neighbors = [];
          for (const dir of hexDirections) {
            const neighborHex = new HexGrid.Hex(cell.hex.q + dir.q, cell.hex.r + dir.r);
            const nIdx = hexesInPiece.get(neighborHex.key());
            if (nIdx !== undefined) neighbors.push(nIdx);
          }
          adjacencyMap.set(cell.hex.key(), neighbors);
        });

        // 1. Find all connected components (BFS)
        const components = [];
        const visited = new Set();
        for (let i = 0; i < cellsWithCenters.length; i++) {
          if (visited.has(i)) continue;
          const queue = [i];
          const comp = [];
          visited.add(i);
          while (queue.length) {
            const idx = queue.shift();
            comp.push(idx);
            const neighbors = adjacencyMap.get(cellsWithCenters[idx].hex.key());
            for (const n of neighbors) {
              if (!visited.has(n)) {
                visited.add(n);
                queue.push(n);
              }
            }
          }
          components.push(comp);
        }

        // 2. For each component, build a spanning tree (no cycles)
        function buildPolylinesForComponent(comp) {
          const polylines = [];

          if (comp.length === 0) return polylines;

          // Build spanning tree using BFS to connect all hexes without cycles
          const visited = new Set();
          const queue = [comp[0]];
          visited.add(comp[0]);

          while (queue.length > 0) {
            const idx = queue.shift();
            const neighbors = adjacencyMap.get(cellsWithCenters[idx].hex.key());

            for (const neighborIdx of neighbors) {
              if (!visited.has(neighborIdx)) {
                visited.add(neighborIdx);
                queue.push(neighborIdx);
                // Draw edge from parent to child in spanning tree
                polylines.push([
                  cellsWithCenters[idx].center,
                  cellsWithCenters[neighborIdx].center
                ]);
              }
            }

            // Handle isolated hexes (degree 0) - draw a small dot
            if (neighbors.length === 0) {
              polylines.push([cellsWithCenters[idx].center]);
            }
          }

          return polylines;
        }

        let allPolylines = [];
        for (const comp of components) {
          allPolylines = allPolylines.concat(buildPolylinesForComponent(comp));
        }

        // 3. If multiple truly disjoint components, connect them by closest pair
        if (components.length > 1) {
          // Only connect if the components are truly disjoint (no shared hexes)
          // Find closest pair between any two components
          const compCenters = components.map(comp => comp.map(idx => cellsWithCenters[idx].center));
          let minDist = Infinity, minPair = null, minI = -1, minJ = -1;
          for (let i = 0; i < compCenters.length; i++) {
            for (let j = i+1; j < compCenters.length; j++) {
              for (const a of compCenters[i]) {
                for (const b of compCenters[j]) {
                  const dx = a[0] - b[0], dy = a[1] - b[1];
                  const dist = dx*dx + dy*dy;
                  if (dist < minDist) {
                    minDist = dist;
                    minPair = [a, b];
                    minI = i;
                    minJ = j;
                  }
                }
              }
            }
          }
          // Only add connection if the two components are not already connected
          if (minPair && minI !== minJ && minI !== -1 && minJ !== -1) {
            allPolylines.push([minPair[0], minPair[1]]);
          }
        }

        // 4. Draw all polylines
        for (const path of allPolylines) {
          const pts = path.map(p => p.join(',')).join(' ');
          const outline = document.createElementNS(svgNS, 'polyline');
          outline.setAttribute('points', pts);
          outline.setAttribute('fill', 'none');
          outline.setAttribute('stroke', '#000');
          outline.setAttribute('stroke-opacity', '0.5');
          outline.setAttribute('stroke-width', '6');
          outline.setAttribute('stroke-linecap', 'round');
          outline.setAttribute('stroke-linejoin', 'round');
          svg.appendChild(outline);
          // main polyline (color matches fill)
          const main = document.createElementNS(svgNS, 'polyline');
          main.setAttribute('points', pts);
          main.setAttribute('fill', 'none');
          const polyColor = isHighContrast ? pieceColorVariations[piece.id] : (piece.color || '#fff');
          main.setAttribute('stroke', polyColor);
          main.setAttribute('stroke-opacity', '0.85');
          main.setAttribute('stroke-width', '4');
          main.setAttribute('stroke-linecap', 'round');
          main.setAttribute('stroke-linejoin', 'round');
          svg.appendChild(main);
        }
      }
    });

    // If any pieces had debug markers from loadBoardConfig, outline them now
    pieces.forEach(p => {
      if (p.__debug_actual) {
        p.__debug_actual.forEach(k => {
          const [q, r] = k.split(',');
          const el = boardContainer.querySelector(`.hexgrid-cell[data-q="${q}"][data-r="${r}"]`);
          if (el) el.style.outline = '3px solid rgba(255,0,0,0.9)';
        });
        delete p.__debug_actual;
      }
      if (p.__debug_expected) {
        p.__debug_expected.forEach(k => {
          const [q, r] = k.split(',');
          const el = boardContainer.querySelector(`.hexgrid-cell[data-q="${q}"][data-r="${r}"]`);
          if (el) el.style.outline = '3px dashed rgba(255,165,0,0.9)';
        });
        delete p.__debug_expected;
      }
    });
  }
  // localStorage save/load
  function saveCollection(){
    localStorage.setItem('hex_pieces', JSON.stringify({seq: pieceIdSeq, pieces: pieces}));
  }
  function loadCollection(){
    try {
      const d = JSON.parse(localStorage.getItem('hex_pieces'));
      if (d && Array.isArray(d.pieces)) {
        pieces = d.pieces.map(p => ({
          id: p.id,
          colorKey: p.colorKey,
          color: PALETTE[p.colorKey],
          cells: (p.cells||[]).map(h => new HexGrid.Hex(h.q, h.r))
        }));
        pieceIdSeq = d.seq || (pieces.length+1);
      }
    } catch(e) {}
  }

  function saveBoardConfig(w, h, solution){
    localStorage.setItem('hex_board', JSON.stringify({w: Number(w), h: Number(h), solution: solution||[]}));
  }
  function loadBoardConfig(){
    try {
      const d = JSON.parse(localStorage.getItem('hex_board'));
      if (d && d.w && d.h) {
        boardW.value = d.w;
        boardH.value = d.h;
        // reconstruct solution if present
        if (Array.isArray(d.solution) && d.solution.length && pieces.length) {
          boardGrid = new HexGrid.HexGrid();
          boardGrid.generateRect(d.w, d.h);
          d.solution.forEach(s => {
            const piece = pieces.find(p => p.id === s.piece);
            if (!piece) return;
            piece.cells.forEach(off => {
              const ro = HexGrid.rotate(off, s.rot);
              const target = HexGrid.add(new HexGrid.Hex(s.anchor.q, s.anchor.r), ro);
              if (boardGrid.has(target)) {
                boardGrid.set(target, {color: piece.color});
              }
            });
          });
          // After reconstructing, run a consistency check comparing the saved
          // rotated offsets with the actually placed offsets so we can detect
          // mismatches (this helps debugging mangled pieces from saved data).
          try {
            d.solution.forEach(s => {
              const piece = pieces.find(p => p.id === s.piece);
              if (!piece) return;
              const rotated = piece.cells.map(off => HexGrid.rotate(off, s.rot));
              const placed = rotated.map(rh => HexGrid.add(new HexGrid.Hex(s.anchor.q, s.anchor.r), rh));
              const placedInBoard = placed.filter(t => boardGrid.has(t));
              const placedKeys = new Set(placedInBoard.map(t => t.key()));
              // find board cells that contain this piece id by color match
              const actualKeys = new Set();
              boardGrid.forEach(c => {
                if (c.data && c.data.color === piece.color) actualKeys.add(c.hex.key());
              });
              const rotKeys = new Set(rotated.map(h => h.q+','+h.r));
              const placedOffsetKeys = new Set(placedInBoard.map(t => {
                const offset = HexGrid.subtract(t, new HexGrid.Hex(s.anchor.q, s.anchor.r));
                return offset.q + ',' + offset.r;
              }));
              const equal = rotKeys.size === placedOffsetKeys.size && [...rotKeys].every(k => placedOffsetKeys.has(k));
              if (!equal) {
                console.error('loadBoardConfig: placement mismatch for piece', piece.id, 'anchor', s.anchor, 'rot', s.rot);
                console.error('expected rotated offsets:', [...rotKeys]);
                console.error('placed offsets on board:', [...placedOffsetKeys]);
                // mark actual placed cells (by color match) and expected cells
                // to make it obvious in the UI after render
                // We'll store markers to apply after renderBoard draws the DOM
                piece.__debug_expected = placed.map(t => t.key());
                piece.__debug_actual = [...actualKeys];
              }
            });
          } catch(e) { console.error(e); }
          renderBoard();
        }
      }
    } catch(e) {}
  }

  // utilities to allow using HexGrid functions here
  // HexGrid.add exists in library as internal function, so expose small wrapper
  // but to avoid relying on that internal, create local add that uses HexGrid.Hex
  // however the hexgrid.js defines add internally; we will use HexGrid.rotate

  // expose a few helpers for console debugging
  window._puzzler = {
    pieces: pieces,
    boardGrid: ()=> boardGrid,
    renderBoard: renderBoard
  };

  // init on DOM ready
  document.addEventListener('DOMContentLoaded', function(){
    loadCollection();
    init();
    loadBoardConfig();
  });
})();
