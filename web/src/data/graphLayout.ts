/**
 * The force layout behind the library graph, kept apart from the renderer so
 * the property that actually matters — that it settles, at any size — can be
 * tested without a canvas.
 *
 * The layout cools. An uncooled simulation looks alive at fifty nodes and
 * looks broken at a thousand: every constant below is either scaled by density
 * or damped by `alpha`, and both were missing in the first cut.
 */

export interface LayoutBody {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  pinned: boolean;
}

export interface LayoutNode {
  id: string;
  radius: number;
}

export interface LayoutEdge {
  source: string;
  target: string;
  kind: "tag" | "mention";
  weight: number;
}

export interface StepOptions {
  /** The phone's constellation packs tighter, so its links sit shorter. */
  narrow?: boolean;
  /** One body is being dragged and must move even though it is pinned. */
  dragging?: string | null;
  /** Frame bounds in world units, applied as soft walls once framed. */
  limitX?: number;
  limitY?: number;
}

/**
 * Above this the drift is switched off and the layout comes to a full stop.
 *
 * Perpetual motion is an aesthetic that stops working at scale: a thousand
 * points each on their own random walk is not life, it is noise, and it costs
 * a frame's work forever to draw. Small libraries keep the breathing.
 */
export const DRIFT_NODE_LIMIT = 120;

/**
 * Cooling schedule. Roughly 200 ticks to a standstill — about three seconds,
 * which is long enough for the layout to find its shape and short enough that
 * nobody watches it wander.
 */
const ALPHA_DECAY = 0.03;
/** Alpha below this is motion nobody can see, so the loop may stop. */
const ALPHA_MIN = 0.002;
const DRIFT_ALPHA_FLOOR = 0.05;
const REPULSION = 1500;
const VELOCITY_DECAY = 0.86;
const MAX_SPEED = 6;
/** Below this the layout is standing still to the eye and the loop can stop. */
const SETTLED_SPEED = 0.05;

/**
 * Density-aware constants.
 *
 * A thousand nodes need a bigger world than fifty, not the same world with
 * more things crushed into it. Everything spatial scales with the square root
 * of the node count, which is how the area grows with the population.
 */
export function layoutScale(nodeCount: number): number {
  return Math.max(1, Math.sqrt(nodeCount / 48));
}

export class GraphLayout {
  readonly bodies = new Map<string, LayoutBody>();
  order: LayoutBody[] = [];
  private edges: LayoutEdge[] = [];
  private alphaValue = 1;
  private floor = DRIFT_ALPHA_FLOOR;
  private scale = 1;
  private settledValue = false;
  private reduced = false;

  get alpha(): number {
    return this.alphaValue;
  }

  /** True once nothing is moving and nothing will move without a nudge. */
  get settled(): boolean {
    return this.settledValue;
  }

  /** Under reduced motion the floor is zero, so it stops rather than breathes. */
  setReducedMotion(reduced: boolean): void {
    this.reduced = reduced;
    this.applyFloor();
  }

  /**
   * Reconciles the body set against a projection.
   *
   * Surviving nodes keep their position and velocity, so a filter change
   * re-forms the layout around what is left rather than restarting it.
   */
  sync(nodes: LayoutNode[], edges: LayoutEdge[]): void {
    this.edges = edges;
    this.scale = layoutScale(nodes.length);
    const next: LayoutBody[] = [];
    const keep = new Set<string>();

    for (const node of nodes) {
      keep.add(node.id);
      const existing = this.bodies.get(node.id);
      if (existing) {
        existing.radius = node.radius;
        next.push(existing);
        continue;
      }
      const seeded = seedPosition(node.id, this.scale);
      const body: LayoutBody = {
        id: node.id,
        x: seeded.x,
        y: seeded.y,
        vx: 0,
        vy: 0,
        radius: node.radius,
        pinned: false,
      };
      this.bodies.set(node.id, body);
      next.push(body);
    }
    for (const id of [...this.bodies.keys()]) {
      if (!keep.has(id)) this.bodies.delete(id);
    }

    this.order = next;
    this.applyFloor();
    this.reheat();
  }

  /**
   * Puts energy back in. A new node set earns the full amount; handling one
   * node earns a fraction, or grabbing a save would set the whole field off.
   */
  reheat(amplitude = 1): void {
    this.alphaValue = Math.max(this.alphaValue, amplitude);
    this.settledValue = false;
  }

  /**
   * Runs the layout to rest before anything is drawn.
   *
   * A force layout resolving itself is not a thing anyone needs to watch: at a
   * thousand nodes it is five seconds of everything moving at once. The work is
   * the same either way, so it happens up front and the first painted frame is
   * the settled one. The budget bounds the pause on very large graphs; whatever
   * is left finishes live, by which point alpha is low and the motion is small.
   */
  settle(options: StepOptions = {}, maxTicks = 600, budgetMs = 550): number {
    const started = performance.now();
    let ticks = 0;
    while (ticks < maxTicks) {
      if (!this.step(options)) break;
      ticks += 1;
      // Checked in blocks, because the clock costs more than the tick does.
      if (ticks % 32 === 0 && performance.now() - started > budgetMs) break;
    }
    return ticks;
  }

  private applyFloor(): void {
    this.floor =
      this.reduced || this.order.length > DRIFT_NODE_LIMIT ? 0 : DRIFT_ALPHA_FLOOR;
  }

  /**
   * One tick. Returns false once the layout has settled and the caller can
   * stop asking.
   */
  step(options: StepOptions = {}): boolean {
    const bodies = this.order;
    if (bodies.length === 0) return false;

    this.alphaValue += (this.floor - this.alphaValue) * ALPHA_DECAY;
    const alpha = this.alphaValue;
    const narrow = options.narrow ?? false;

    // Repulsion through a quadtree: the only O(n²) force here, and the reason
    // a thousand nodes is four million pair tests a frame without one.
    const cutoff = (300 * this.scale) ** 2;
    const tree = bodies.length > 48 ? buildQuadtree(bodies) : null;
    for (const body of bodies) {
      if (tree) applyRepulsion(tree, body, cutoff);
      else {
        for (const other of bodies) {
          if (other !== body) repel(body, other.x, other.y, 1, cutoff);
        }
      }
    }

    for (const edge of this.edges) {
      const from = this.bodies.get(edge.source);
      const to = this.bodies.get(edge.target);
      if (!from || !to) continue;
      // Co-mentions pull tighter than tag membership: a pair someone wrote
      // about together is a stronger statement than a shared tag.
      const rest = edge.kind === "mention" ? (narrow ? 42 : 56) : narrow ? 58 : 82;
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const strength =
        ((distance - rest) * (edge.kind === "mention" ? 0.014 : 0.02)) /
        Math.max(1, Math.log2(1 + edge.weight));
      from.vx += (dx / distance) * strength;
      from.vy += (dy / distance) * strength;
      to.vx -= (dx / distance) * strength;
      to.vy -= (dy / distance) * strength;
    }

    // Centring has to weaken as the population grows or it crushes a large
    // library into one over-energised ball that can never come to rest.
    const gravity = 0.0022 / this.scale;
    const drift = this.floor > 0;
    let fastest = 0;

    for (const body of bodies) {
      body.vx -= body.x * gravity;
      body.vy -= body.y * gravity * 1.18;
      if (drift) {
        // The design system bans CSS motion, so what life the graph has must
        // live in the pixels. Damped by alpha, this is a breath, not a walk.
        body.vx += (Math.random() - 0.5) * 0.09 * alpha;
        body.vy += (Math.random() - 0.5) * 0.09 * alpha;
      }
      body.vx *= VELOCITY_DECAY;
      body.vy *= VELOCITY_DECAY;
      let speed = Math.hypot(body.vx, body.vy);
      if (speed > MAX_SPEED) {
        body.vx = (body.vx / speed) * MAX_SPEED;
        body.vy = (body.vy / speed) * MAX_SPEED;
        // Measured after the clamp, because this is what "is anything still
        // moving" has to mean. Two nearly-coincident nodes carry a repulsion
        // force in the thousands, and reading the speed before the cap let a
        // single such pair hold the whole layout "in motion" indefinitely.
        speed = MAX_SPEED;
      }
      if (!body.pinned || options.dragging === body.id) {
        // Alpha scales the displacement, not the forces: the layout still
        // resolves its structure, it just stops travelling to do it.
        body.x += body.vx * alpha;
        body.y += body.vy * alpha;
      }
      const moved = speed * alpha;
      if (moved > fastest) fastest = moved;
    }

    // Soft walls at the frame edge: drift stays alive, but nothing wanders out
    // of the panel and becomes unreachable.
    if (options.limitX && options.limitY) {
      for (const body of bodies) {
        const overX = Math.abs(body.x) - options.limitX;
        const overY = Math.abs(body.y) - options.limitY;
        if (overX > 0) body.vx -= Math.sign(body.x) * Math.min(overX, 400) * 0.012;
        if (overY > 0) body.vy -= Math.sign(body.y) * Math.min(overY, 400) * 0.012;
      }
    }

    this.settledValue =
      this.alphaValue <= this.floor + ALPHA_MIN && fastest < SETTLED_SPEED;
    return !this.settledValue;
  }

  /** The world-space box the layout currently occupies. */
  bounds(): { minX: number; minY: number; maxX: number; maxY: number } | null {
    if (this.order.length === 0) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const body of this.order) {
      if (body.x < minX) minX = body.x;
      if (body.y < minY) minY = body.y;
      if (body.x > maxX) maxX = body.x;
      if (body.y > maxY) maxY = body.y;
    }
    return { minX, minY, maxX, maxY };
  }
}

/**
 * A node's opening position is a function of its id, so the same library opens
 * to the same layout instead of a different scatter every time — and the disc
 * grows with the population, or a large library starts as one dense knot and
 * spends its first seconds exploding out of it.
 */
export function seedPosition(id: string, scale = 1): { x: number; y: number } {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const angle = ((hash & 0xffff) / 0xffff) * Math.PI * 2;
  const radius = (40 + ((hash >>> 16) / 0xffff) * 260) * scale;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

function repel(
  body: LayoutBody,
  x: number,
  y: number,
  mass: number,
  cutoff: number,
): void {
  let dx = body.x - x;
  let dy = body.y - y;
  let squared = dx * dx + dy * dy;
  if (squared < 1) {
    // Coincident bodies have no direction to separate along, so one is
    // invented deterministically from the id.
    dx = (body.id.charCodeAt(0) % 3) - 1 || 0.7;
    dy = (body.id.charCodeAt(1) % 3) - 1 || 0.7;
    squared = 2;
  }
  if (squared > cutoff) return;
  const distance = Math.sqrt(squared);
  const force = (REPULSION * mass) / squared;
  body.vx += (dx / distance) * force;
  body.vy += (dy / distance) * force;
}

/* ---- Barnes–Hut ---- */

interface Cell {
  cx: number;
  cy: number;
  mass: number;
  size: number;
  body: LayoutBody | null;
  children: (Cell | null)[] | null;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Opening angle. Higher approximates more aggressively and costs less. */
const THETA = 0.9;

function applyRepulsion(cell: Cell, body: LayoutBody, cutoff: number): void {
  if (cell.mass === 0) return;
  const dx = cell.cx - body.x;
  const dy = cell.cy - body.y;
  const distance = Math.hypot(dx, dy);
  if (cell.children === null) {
    if (cell.body && cell.body !== body) {
      repel(body, cell.cx, cell.cy, cell.mass, cutoff);
    }
    return;
  }
  // Far enough that the whole cell can stand in for its contents.
  if (cell.size / Math.max(distance, 0.001) < THETA) {
    repel(body, cell.cx, cell.cy, cell.mass, cutoff);
    return;
  }
  for (const child of cell.children) {
    if (child) applyRepulsion(child, body, cutoff);
  }
}

function buildQuadtree(bodies: LayoutBody[]): Cell {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const body of bodies) {
    if (body.x < minX) minX = body.x;
    if (body.y < minY) minY = body.y;
    if (body.x > maxX) maxX = body.x;
    if (body.y > maxY) maxY = body.y;
  }
  const size = Math.max(maxX - minX, maxY - minY, 1) + 2;
  const root = makeCell(minX - 1, minY - 1, minX - 1 + size, minY - 1 + size);
  for (const body of bodies) insert(root, body, 0);
  return root;
}

function makeCell(x0: number, y0: number, x1: number, y1: number): Cell {
  return {
    cx: 0,
    cy: 0,
    mass: 0,
    size: x1 - x0,
    body: null,
    children: null,
    x0,
    y0,
    x1,
    y1,
  };
}

function insert(cell: Cell, body: LayoutBody, depth: number): void {
  // Centre of mass accumulates on the way down, so no second pass is needed.
  cell.cx = (cell.cx * cell.mass + body.x) / (cell.mass + 1);
  cell.cy = (cell.cy * cell.mass + body.y) / (cell.mass + 1);
  cell.mass += 1;

  if (cell.children === null) {
    if (cell.body === null) {
      cell.body = body;
      return;
    }
    // Coincident bodies would subdivide forever, so depth is the backstop.
    if (depth > 20) return;
    const existing = cell.body;
    cell.body = null;
    cell.children = [null, null, null, null];
    place(cell, existing, depth);
    place(cell, body, depth);
    return;
  }
  place(cell, body, depth);
}

function place(cell: Cell, body: LayoutBody, depth: number): void {
  const midX = (cell.x0 + cell.x1) / 2;
  const midY = (cell.y0 + cell.y1) / 2;
  const east = body.x >= midX;
  const south = body.y >= midY;
  const index = (south ? 2 : 0) + (east ? 1 : 0);
  const children = cell.children!;
  let child = children[index] ?? null;
  if (!child) {
    child = makeCell(
      east ? midX : cell.x0,
      south ? midY : cell.y0,
      east ? cell.x1 : midX,
      south ? cell.y1 : midY,
    );
    children[index] = child;
  }
  insert(child, body, depth + 1);
}
