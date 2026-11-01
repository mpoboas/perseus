use criterion::{Criterion, criterion_group, criterion_main};
use perseus_lib::git::lanes::{LaneAllocator, synthetic_history};

fn lane_allocation(c: &mut Criterion) {
    let mut group = c.benchmark_group("lane_allocation");
    group.sample_size(10);
    for n in [50_000u32, 500_000] {
        let history = synthetic_history(n, 1);
        group.bench_function(format!("{n}_commits"), |b| {
            b.iter(|| {
                let mut alloc = LaneAllocator::new();
                for (id, parents) in &history {
                    std::hint::black_box(alloc.push(*id, parents));
                }
                alloc.max_lanes()
            })
        });
    }
    group.finish();
}

criterion_group!(benches, lane_allocation);
criterion_main!(benches);
