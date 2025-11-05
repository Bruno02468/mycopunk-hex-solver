/*
  Simple Hex Grid Library — pure browser JavaScript

  Exposes global `HexGrid` object with:
    - Hex: lightweight axial hex coordinate helper
    - HexGrid: data structure for a hex grid (generate, get, set, neighbors, range, path)
    - Renderer: renders a HexGrid into a container using DIVs and CSS (no canvas)

  Usage: include this script in a page, create a HexGrid, then new HexGrid.Renderer(container, grid, opts).
*/

(function(global){
  'use strict';

  // Helper: axial hex coordinate (q, r). s = -q-r
  class Hex {
    constructor(q, r){
      this.q = +q;
      this.r = +r;
      this.s = -this.q - this.r;
    }
    key(){ return this.q + ',' + this.r; }
    equals(b){ return this.q === b.q && this.r === b.r; }
  }

  const HEX_DIRECTIONS = [
    new Hex(1, 0), new Hex(1, -1), new Hex(0, -1),
    new Hex(-1, 0), new Hex(-1, 1), new Hex(0, 1)
  ];

  function add(a, b){ return new Hex(a.q + b.q, a.r + b.r); }
  function subtract(a, b){ return new Hex(a.q - b.q, a.r - b.r); }
  function scale(a, k){ return new Hex(a.q * k, a.r * k); }
  function neighbor(hex, direction){
    const d = HEX_DIRECTIONS[direction % 6];
    return add(hex, d);
  }

  function hex_distance(a, b){
    return (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(a.s - b.s)) / 2;
  }

  // Linear interpolation on cube coords for line drawing
  function lerp(a, b, t){ return a + (b - a) * t; }
  function cube_lerp(a, b, t){
    return {
      x: lerp(a.q, b.q, t),
      y: lerp(a.r, b.r, t),
      z: lerp(a.s, b.s, t)
    };
  }
  function cube_round(frac){
    let rx = Math.round(frac.x);
    let ry = Math.round(frac.y);
    let rz = Math.round(frac.z);
    const x_diff = Math.abs(rx - frac.x);
    const y_diff = Math.abs(ry - frac.y);
    const z_diff = Math.abs(rz - frac.z);
    if (x_diff > y_diff && x_diff > z_diff) rx = -ry - rz;
    else if (y_diff > z_diff) ry = -rx - rz;
    else rz = -rx - ry;
    return new Hex(rx, ry);
  }

  // Grid data structure
  class HexGrid {
    constructor(){
      // Map keyed by 'q,r' -> {hex: Hex, data: any}
      this.cells = new Map();
    }

    // generate a hex-shaped region with given radius (0 -> single hex)
    generateRadius(radius){
      this.cells.clear();
      for (let q = -radius; q <= radius; q++){
        const r1 = Math.max(-radius, -q - radius);
        const r2 = Math.min(radius, -q + radius);
        for (let r = r1; r <= r2; r++){
          const h = new Hex(q, r);
          this.cells.set(h.key(), {hex: h, data: null});
        }
      }
      return this;
    }

    set(hex, data){
      this.cells.set(hex.key(), {hex, data});
    }

    get(hex){
      return this.cells.get(hex.key()) || null;
    }

    has(hex){ return this.cells.has(hex.key()); }

    forEach(fn){
      this.cells.forEach((v) => fn(v, v.hex));
    }

    neighbors(hex){
      const out = [];
      for (let i=0;i<6;i++){
        const n = neighbor(hex, i);
        const c = this.get(n);
        if (c) out.push(c);
      }
      return out;
    }

    range(center, radius){
      const results = [];
      for (let dq = -radius; dq <= radius; dq++){
        for (let dr = Math.max(-radius, -dq-radius); dr <= Math.min(radius, -dq+radius); dr++){
          const h = add(center, new Hex(dq, dr));
          const c = this.get(h);
          if (c) results.push(c);
        }
      }
      return results;
    }

    ring(center, radius){
      const results = [];
      if (radius === 0){
        const c = this.get(center);
        if (c) results.push(c);
        return results;
      }
      let hex = add(center, scale(HEX_DIRECTIONS[4], radius));
      for (let i=0;i<6;i++){
        for (let j=0;j<radius;j++){
          const c = this.get(hex);
          if (c) results.push(c);
          hex = neighbor(hex, i);
        }
      }
      return results;
    }

    line(a, b){
      const N = hex_distance(a, b);
      const results = [];
      for (let i=0;i<=N;i++){
        const t = N===0?0:i/N;
        const c = cube_round(cube_lerp(a, b, t));
        const cell = this.get(c);
        if (cell) results.push(cell);
      }
      return results;
    }
  }
  // rectangular grid generator, get array and clear helpers
  HexGrid.prototype.generateRect = function(width, height, q0, r0){
    q0 = q0 || 0;
    r0 = r0 || 0;
    this.cells.clear();
    // Flat-top rectangle: q in [0,width-1], r in [0,height-1]
    for (let q = q0; q < q0 + width; q++){
      for (let r = r0; r < r0 + height; r++){
        const h = new Hex(q, r);
        this.cells.set(h.key(), {hex: h, data: null});
      }
    }
    return this;
  };

  HexGrid.prototype.getCellsArray = function(){
    const out = [];
    this.cells.forEach((v) => out.push(v));
    return out;
  };

  HexGrid.prototype.clearData = function(){
    this.cells.forEach((v) => { v.data = null; });
  };

  function rotateHex(hex, times){
    times = ((times % 6) + 6) % 6;
    if (times === 0) return new Hex(hex.q, hex.r);

    // Convert odd-q offset to axial for rotation
    const axial_q = hex.q;
    const axial_r = hex.r - (hex.q - (hex.q & 1)) / 2;

    // Rotate in axial/cube space
    let x = axial_q, y = axial_r, z = -axial_q - axial_r;
    for (let i = 0; i < times; i++){
      const nx = -z;
      const ny = -x;
      const nz = -y;
      x = nx; y = ny; z = nz;
    }

    // Convert back to odd-q offset
    const offset_q = x;
    const offset_r = y + (x - (x & 1)) / 2;
    return new Hex(offset_q, offset_r);
  }

  function addHex(a, b){
    // Addition in odd-q offset coordinates
    // Convert to axial, add, convert back
    const a_axial_q = a.q;
    const a_axial_r = a.r - (a.q - (a.q & 1)) / 2;
    const b_axial_q = b.q;
    const b_axial_r = b.r - (b.q - (b.q & 1)) / 2;

    const sum_axial_q = a_axial_q + b_axial_q;
    const sum_axial_r = a_axial_r + b_axial_r;

    const offset_q = sum_axial_q;
    const offset_r = sum_axial_r + (sum_axial_q - (sum_axial_q & 1)) / 2;

    return new Hex(offset_q, offset_r);
  }

  function subtractHex(a, b){
    // Subtraction in odd-q offset coordinates
    // Convert to axial, subtract, convert back
    const a_axial_q = a.q;
    const a_axial_r = a.r - (a.q - (a.q & 1)) / 2;
    const b_axial_q = b.q;
    const b_axial_r = b.r - (b.q - (b.q & 1)) / 2;

    const diff_axial_q = a_axial_q - b_axial_q;
    const diff_axial_r = a_axial_r - b_axial_r;

    const offset_q = diff_axial_q;
    const offset_r = diff_axial_r + (diff_axial_q - (diff_axial_q & 1)) / 2;

    return new Hex(offset_q, offset_r);
  }

  // Renderer: shows hex cells as divs positioned absolutely and shaped with clip-path.
  class Renderer {

    constructor(container, grid, options = {}){
      this.container = (typeof container === 'string') ? document.querySelector(container) : container;
      if (!this.container) throw new Error('container element not found');
      this.grid = grid;
      this.size = options.size || 40; // radius in px
      this.spacing = typeof options.spacing === 'number' ? options.spacing : 3; // px between hexes
      this.showCoords = options.showCoords || false;
      this.pointy = true; // pointy-top hexes
      this.cellElements = new Map();
      this.selected = null;
      this.enableSelection = options.enableSelection !== false;
      this._ensureStyles();
      this.container.style.position = this.container.style.position || 'relative';
      this.container.innerHTML = '';
      this._createElements();
    }

    // ensure CSS styles exist once
    _ensureStyles(){
      if (document.getElementById('hexgrid-styles')) return;
      const style = document.createElement('style');
      style.id = 'hexgrid-styles';
      style.textContent = `
        .hexgrid-cell { position: absolute; box-sizing: border-box; cursor: pointer; display:flex; align-items:center; justify-content:center; font-size:12px; color:#111 }
        .hexgrid-cell .label { pointer-events:none; }
        .hexgrid-cell.default { background: #f5f5f5; border:0px solid #aaa; }
        .hexgrid-cell:hover { filter: brightness(0.95); }
        .hexgrid-cell.selected { outline: 3px solid rgba(33,150,243,0.9); z-index:2 }
        .hexgrid-cell.neighbor { outline: 2px dashed rgba(0,0,0,0.15) }
      `;
      document.head.appendChild(style);
    }

    _hexToPixel(hex){
      // Convert axial coordinates (q,r) to flat-top pixel positions
      // Flat-top orientation: odd columns offset down by half hex height
      const size = this.size;
      const spacing = this.spacing;
      // x = size * 3/2 * q (columns are spaced by 3/2 of hex width)
      // y = size * sqrt(3) * r + (q % 2) * size * sqrt(3)/2 (odd columns down by half)
      const x = (size * 3/2 + spacing * 0.75) * hex.q;
      const y = (size * Math.sqrt(3) + spacing) * hex.r + (Math.abs(hex.q) % 2) * (size * Math.sqrt(3)/2);
      return {x, y};
    }

    _createElements(){
      // compute bounding box and align top of first and last columns for flat-top rectangle
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      let minQ = Infinity, maxQ = -Infinity;
      const coords = [];
      this.grid.forEach((cell) => {
        const p = this._hexToPixel(cell.hex);
        coords.push({cell, p});
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
        minQ = Math.min(minQ, cell.hex.q);
        maxQ = Math.max(maxQ, cell.hex.q);
      });

      // Flat-top hex geometry: width = 2*size, height = sqrt(3)*size
      const hexW = 2 * this.size;
      const hexH = Math.sqrt(3) * this.size;
      const padding = 10;

      // For flat-top rectangle: align the top of the first and last columns
      // The vertical offset for a column is size * sqrt(3)/2 * q
      // So the top of the first column is at y0, last column at y0 + (maxQ-minQ)*size*sqrt(3)/2
      // We want the board to be a true rectangle, so adjust minY/maxY accordingly
      const colOffset = this.size * Math.sqrt(3)/2;
      // Find the minimum y for each column
      let minYByQ = {};
      coords.forEach(({cell, p}) => {
        const q = cell.hex.q;
        if (!(q in minYByQ) || p.y < minYByQ[q]) minYByQ[q] = p.y;
      });
      // The highest (smallest) y among all columns
      let alignY = Math.min(...Object.values(minYByQ));

      // The lowest (largest) y among the bottoms of all columns
      let maxYByQ = {};
      coords.forEach(({cell, p}) => {
        const q = cell.hex.q;
        if (!(q in maxYByQ) || p.y > maxYByQ[q]) maxYByQ[q] = p.y;
      });
      let alignMaxY = Math.max(...Object.values(maxYByQ));

      const width = (maxX - minX) + hexW + padding*2;
      const height = (alignMaxY - alignY) + hexH + padding*2;
      this.container.style.width = Math.ceil(width) + 'px';
      this.container.style.height = Math.ceil(height) + 'px';

      const offsetX = -minX + padding;
      const offsetY = -alignY + padding;

      coords.forEach(({cell, p}) => {
        const el = document.createElement('div');
        el.className = 'hexgrid-cell default';
        el.style.width = Math.round(hexW) + 'px';
        el.style.height = Math.round(hexH) + 'px';
        el.style.left = Math.round(p.x + offsetX - hexW/2) + 'px';
        el.style.top = Math.round(p.y + offsetY - hexH/2) + 'px';
        // Flat-top hex shape
        el.style.clipPath = 'polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)';
        el.dataset.q = cell.hex.q;
        el.dataset.r = cell.hex.r;
        el.title = `q=${cell.hex.q}, r=${cell.hex.r}`;

        const label = document.createElement('div');
        label.className = 'label';
        label.textContent = this.showCoords ? `${cell.hex.q},${cell.hex.r}` : '';
        el.appendChild(label);

        // attach element
        this.container.appendChild(el);
        this.cellElements.set(cell.hex.key(), el);

        // style by data if present
        if (cell.data && cell.data.color) el.style.background = cell.data.color;

        // events
        if (this.enableSelection) {
          el.addEventListener('click', (ev) => {
            this._onCellClick(cell, el, ev);
          });
        }
      });
    }

    _onCellClick(cell, el, ev){
      // toggle selection
      if (this.selected){
        const prevEl = this.cellElements.get(this.selected.key());
        if (prevEl) prevEl.classList.remove('selected');
        // remove neighbor marks
        this._clearNeighborMarks();
        if (this.selected.equals(cell)){
          this.selected = null;
          return;
        }
      }
      this.selected = cell.hex;
      el.classList.add('selected');
      // mark neighbors
      const neigh = this.grid.neighbors(cell.hex);
      neigh.forEach(n => {
        const e = this.cellElements.get(n.hex.key());
        if (e) e.classList.add('neighbor');
      });
    }

    _clearNeighborMarks(){
      this.cellElements.forEach((el) => el.classList.remove('neighbor'));
    }

    // utility: update data on a cell and refresh its element
    updateCell(hex, data){
      const cell = this.grid.get(hex);
      if (!cell) return;
      cell.data = data;
      const el = this.cellElements.get(hex.key());
      if (!el) return;
      if (data && data.color) el.style.background = data.color;
      else el.style.background = '';
      if (this.showCoords && el.querySelector('.label')) el.querySelector('.label').textContent = `${hex.q},${hex.r}`;
    }
  }

  // expose API
  global.HexGrid = {
    Hex,
    HexGrid,
    Renderer,
    rotate: rotateHex,
    add: addHex,
    subtract: subtractHex
  };

})(window);
