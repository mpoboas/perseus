//! Lane assignment for the commit graph.
//!
//! Commits arrive in topological order (children before parents). The allocator
//! keeps one slot per vertical lane; a slot holds the id of the commit that lane
//! is waiting for (the parent of some already-seen child). Each call to
//! [`LaneAllocator::push`] returns the geometry of one row, expressed relative to
//! the row's top and bottom edges:
//!
//! * `incoming`: lanes entering from the top that terminate at this commit's node
//! * `through`: lanes passing straight from top to bottom, untouched
//! * `outgoing`: lanes leaving the node towards the bottom, one per parent
//!
//! The allocator is generic over the id type so it stays free of gix/Tauri and
//! can be unit-tested and benchmarked with plain integers.

use serde::Serialize;

/// `(lane, color)`. Colors are opaque indices; the frontend maps them to a palette.
pub type Segment = (u16, u16);

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct LaneRow {
    pub lane: u16,
    pub color: u16,
    pub incoming: Vec<Segment>,
    pub through: Vec<Segment>,
    pub outgoing: Vec<Segment>,
}

#[derive(Clone, Copy)]
struct Slot<Id> {
    waiting: Id,
    color: u16,
}

pub struct LaneAllocator<Id> {
    slots: Vec<Option<Slot<Id>>>,
    next_color: u16,
    max_lanes: usize,
}

impl<Id: Copy + Eq> Default for LaneAllocator<Id> {
    fn default() -> Self {
        Self {
            slots: Vec::new(),
            next_color: 0,
            max_lanes: 0,
        }
    }
}

impl<Id: Copy + Eq> LaneAllocator<Id> {
    pub fn new() -> Self {
        Self::default()
    }

    /// Widest lane count seen so far (useful for sizing the graph column).
    pub fn max_lanes(&self) -> usize {
        self.max_lanes
    }

    fn fresh_color(&mut self) -> u16 {
        let c = self.next_color;
        self.next_color = self.next_color.wrapping_add(1);
        c
    }

    fn first_free(&mut self) -> usize {
        match self.slots.iter().position(Option::is_none) {
            Some(i) => i,
            None => {
                self.slots.push(None);
                self.slots.len() - 1
            }
        }
    }

    fn lane_waiting_for(&self, id: Id) -> Option<usize> {
        self.slots
            .iter()
            .position(|s| s.is_some_and(|s| s.waiting == id))
    }

    /// Places the next commit (in topological order) and returns its row geometry.
    pub fn push(&mut self, id: Id, parents: &[Id]) -> LaneRow {
        let matches: Vec<usize> = self
            .slots
            .iter()
            .enumerate()
            .filter(|(_, s)| s.is_some_and(|s| s.waiting == id))
            .map(|(i, _)| i)
            .collect();

        let (lane, color) = match matches.first() {
            Some(&i) => (i, self.slots[i].map_or(0, |s| s.color)),
            None => {
                let color = self.fresh_color();
                (self.first_free(), color)
            }
        };

        let incoming: Vec<Segment> = matches
            .iter()
            .filter_map(|&i| self.slots[i].map(|s| (i as u16, s.color)))
            .collect();
        let through: Vec<Segment> = self
            .slots
            .iter()
            .enumerate()
            .filter(|(i, _)| !matches.contains(i))
            .filter_map(|(i, s)| s.map(|s| (i as u16, s.color)))
            .collect();
        for &i in &matches {
            self.slots[i] = None;
        }

        let mut outgoing = Vec::with_capacity(parents.len());
        for (n, &parent) in parents.iter().enumerate() {
            if let Some(k) = self.lane_waiting_for(parent) {
                // Parent already has a lane (another child reached it first): join it.
                let c = self.slots[k].map_or(color, |s| s.color);
                outgoing.push((k as u16, c));
            } else if n == 0 {
                // First parent continues straight down the node's own lane.
                self.slots[lane] = Some(Slot {
                    waiting: parent,
                    color,
                });
                outgoing.push((lane as u16, color));
            } else {
                let c = self.fresh_color();
                let k = self.first_free();
                self.slots[k] = Some(Slot {
                    waiting: parent,
                    color: c,
                });
                outgoing.push((k as u16, c));
            }
        }

        self.max_lanes = self.max_lanes.max(self.slots.len());
        while matches!(self.slots.last(), Some(None)) {
            self.slots.pop();
        }

        LaneRow {
            lane: lane as u16,
            color,
            incoming,
            through,
            outgoing,
        }
    }
}

/// Deterministic synthetic history in topological order (index 0 = newest), for
/// tests and benchmarks. Each commit gets 1–3 parents drawn from nearby older
/// commits, which produces realistic branching and merging.
#[doc(hidden)]
pub fn synthetic_history(n: u32, seed: u64) -> Vec<(u32, Vec<u32>)> {
    let mut state = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
    let mut next = move || {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (state >> 33) as u32
    };
    (0..n)
        .map(|i| {
            let mut parents = Vec::new();
            if i + 1 < n {
                parents.push(i + 1 + next() % 3.min(n - i - 1));
                if next() % 8 == 0 {
                    let p = i + 1 + next() % 12.min(n - i - 1);
                    if !parents.contains(&p) {
                        parents.push(p);
                    }
                }
                if next() % 64 == 0 {
                    let p = i + 1 + next() % 20.min(n - i - 1);
                    if !parents.contains(&p) {
                        parents.push(p);
                    }
                }
            }
            (i, parents)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{BTreeMap, HashSet};

    fn layout(history: &[(u32, Vec<u32>)]) -> Vec<LaneRow> {
        let mut alloc = LaneAllocator::new();
        history.iter().map(|(id, p)| alloc.push(*id, p)).collect()
    }

    fn lanes(segs: &[Segment]) -> Vec<u16> {
        segs.iter().map(|s| s.0).collect()
    }

    #[test]
    fn linear_history_stays_in_lane_zero() {
        let rows = layout(&[(0, vec![1]), (1, vec![2]), (2, vec![])]);
        assert!(rows.iter().all(|r| r.lane == 0));
        assert!(rows[0].incoming.is_empty());
        assert_eq!(lanes(&rows[1].incoming), [0]);
        assert!(rows[2].outgoing.is_empty());
        // One color for the whole line.
        assert!(rows.iter().all(|r| r.color == rows[0].color));
    }

    #[test]
    fn merge_forks_a_second_lane_then_rejoins() {
        // 0: merge(1, 2); 1 and 2 both have parent 3.
        let rows = layout(&[(0, vec![1, 2]), (1, vec![3]), (2, vec![3]), (3, vec![])]);
        assert_eq!(lanes(&rows[0].outgoing), [0, 1]);
        assert_eq!(rows[1].lane, 0);
        assert_eq!(rows[1].through.iter().map(|s| s.0).collect::<Vec<_>>(), [1]);
        assert_eq!(rows[2].lane, 1);
        // Commit 2 joins the line already waiting for 3 in lane 0.
        assert_eq!(lanes(&rows[2].outgoing), [0]);
        assert_eq!(rows[3].lane, 0);
        assert_eq!(lanes(&rows[3].incoming), [0]);
    }

    #[test]
    fn octopus_merge_uses_one_lane_per_parent() {
        let rows = layout(&[
            (0, vec![1, 2, 3]),
            (1, vec![4]),
            (2, vec![4]),
            (3, vec![4]),
            (4, vec![]),
        ]);
        assert_eq!(lanes(&rows[0].outgoing), [0, 1, 2]);
        assert_eq!(rows[4].lane, 0);
    }

    #[test]
    fn criss_cross_merges_keep_lanes_distinct() {
        // 0 and 1 are tips that each merge both of 2 and 3.
        let rows = layout(&[
            (0, vec![2, 3]),
            (1, vec![3, 2]),
            (2, vec![4]),
            (3, vec![4]),
            (4, vec![]),
        ]);
        for r in &rows {
            let mut seen = HashSet::new();
            assert!(r.through.iter().all(|s| seen.insert(s.0)));
            assert!(!seen.contains(&r.lane));
        }
    }

    #[test]
    fn freed_lanes_are_reused() {
        // A short-lived branch should not widen the graph for the rest of history.
        let mut history: Vec<(u32, Vec<u32>)> = vec![(0, vec![1, 2]), (1, vec![3]), (2, vec![3])];
        for i in 3..100 {
            history.push((i, vec![i + 1]));
        }
        history.push((100, vec![]));
        let mut alloc = LaneAllocator::new();
        for (id, p) in &history {
            alloc.push(*id, p);
        }
        assert_eq!(alloc.max_lanes(), 2);
        assert!(layout(&history)[10..].iter().all(|r| r.through.is_empty()));
    }

    /// Property check over many random DAGs: what leaves one row at the bottom is
    /// exactly what enters the next row at the top, with matching colors.
    #[test]
    fn rows_connect_edge_to_edge() {
        for seed in 0..40 {
            let history = synthetic_history(400, seed);
            let rows = layout(&history);

            let has_child: HashSet<u32> = history
                .iter()
                .flat_map(|(_, ps)| ps.iter().copied())
                .collect();

            for (i, row) in rows.iter().enumerate() {
                let (id, _) = &history[i];
                // Nodes never sit on a through lane; through lanes are unique.
                let mut seen = HashSet::new();
                assert!(
                    row.through.iter().all(|s| seen.insert(s.0)),
                    "seed {seed} row {i}"
                );
                assert!(!seen.contains(&row.lane), "seed {seed} row {i}");
                // A commit has incoming lines iff some earlier commit lists it as parent.
                assert_eq!(
                    !row.incoming.is_empty(),
                    has_child.contains(id),
                    "seed {seed} row {i}"
                );

                if let Some(next) = rows.get(i + 1) {
                    let bottom: BTreeMap<u16, u16> =
                        row.through.iter().chain(&row.outgoing).copied().collect();
                    let top: BTreeMap<u16, u16> =
                        next.through.iter().chain(&next.incoming).copied().collect();
                    assert_eq!(bottom, top, "seed {seed} between rows {i} and {}", i + 1);
                }
            }
        }
    }
}
