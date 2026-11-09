import type { CommitSummary } from "./protocol";

export interface GraphEdge {
  from: number;
  to: number;
  start: "top" | "node";
  end: "node" | "bottom";
  color: number;
  target: string;
  boundary: boolean;
}

export interface GraphRow {
  oid: string;
  lane: number;
  color: number;
  edges: GraphEdge[];
}

// Input is the complete loaded prefix of a child-before-parent traversal. Keeping
// pending parents in lanes makes pagination deterministic, including at merges.
export function layoutHistoryGraph(commits: readonly Pick<CommitSummary, "oid" | "parents">[]): { rows: GraphRow[]; lanes: number } {
    let active: { oid: string; color: number }[] = [];
    let nextColor = 0;
    let lanes = 1;
    const rows = commits.map((commit, index) => {
        const incoming = active.findIndex((lane) => lane.oid === commit.oid);
        const lane = incoming < 0 ? active.length : incoming;
        if (incoming < 0)
            active.push({ oid: commit.oid, color: nextColor++ });
        const color = active[lane].color;
        const before = active;
        active = active.filter((_, position) => position !== lane);
        const parents = [...new Set(commit.parents)];
        parents.forEach((oid, parentIndex) => {
            if (active.some((item) => item.oid === oid))
                return;
            const parent = { oid, color: parentIndex === 0 ? color : nextColor++ };
            if (parentIndex === 0)
                active.splice(lane, 0, parent);
            else
                active.push(parent);
        });
        const edges: GraphEdge[] = [];
        const boundary = index === commits.length - 1;
        before.forEach((item, position) => {
            if (position === lane) {
                if (incoming >= 0)
                    edges.push({ from: lane, to: lane, start: "top", end: "node", color, target: commit.oid, boundary: false });
            }
            else {
                edges.push({ from: position, to: active.findIndex((next) => next.oid === item.oid), start: "top", end: "bottom", color: item.color, target: item.oid, boundary });
            }
        });
        parents.forEach((oid) => {
            const to = active.findIndex((item) => item.oid === oid);
            edges.push({ from: lane, to, start: "node", end: "bottom", color: active[to].color, target: oid, boundary });
        });
        lanes = Math.max(lanes, before.length, active.length);
        return { oid: commit.oid, lane, color, edges };
    });
    return { rows, lanes };
}
