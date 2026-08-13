use harness_protocol::{DomainEvent, ProviderId};
use harness_store::{NewThread, Store};
use std::hint::black_box;
use std::time::{Duration, Instant};

const EVENT_COUNT: usize = 5_000;
const SAMPLES: usize = 7;

fn main() {
    for _ in 0..2 {
        black_box(measure_append());
    }
    let mut append_samples = Vec::with_capacity(SAMPLES);
    let mut history_samples = Vec::with_capacity(SAMPLES);
    for _ in 0..SAMPLES {
        let (append, history) = measure_append();
        append_samples.push(append);
        history_samples.push(history);
    }
    report("store_append", append_samples, EVENT_COUNT);
    report("store_history", history_samples, EVENT_COUNT);
}

fn measure_append() -> (Duration, Duration) {
    let mut store = Store::memory().expect("open in-memory store");
    store
        .add_project("/performance", Some("performance"))
        .expect("add project");
    store
        .add_thread(NewThread {
            id: "thread-performance".into(),
            project_path: "/performance".into(),
            provider: ProviderId::Codex,
            agent: None,
            title: "Performance".into(),
            created_at: Some(1),
            worktree_path: None,
            worktree_branch: None,
        })
        .expect("add thread");

    let append_started = Instant::now();
    for _ in 0..EVENT_COUNT {
        black_box(
            store
                .append(
                    "thread-performance",
                    &DomainEvent::ItemDelta {
                        turn_id: "turn-live".into(),
                        item_id: "item-live".into(),
                        text_delta: "streamed token ".into(),
                    },
                )
                .expect("append event"),
        );
    }
    let append = append_started.elapsed();

    let history_started = Instant::now();
    let history = store
        .history("thread-performance", 0)
        .expect("read history");
    let history_elapsed = history_started.elapsed();
    assert_eq!(history.len(), EVENT_COUNT);
    black_box(history);
    (append, history_elapsed)
}

fn report(label: &str, mut samples: Vec<Duration>, operations: usize) {
    samples.sort_unstable();
    let median = samples[samples.len() / 2];
    let p95 = samples[((samples.len() as f64 * 0.95).ceil() as usize - 1).min(samples.len() - 1)];
    println!(
        "{label} operations={operations} median_ns={} p95_ns={} median_ns_per_operation={:.2} p95_ns_per_operation={:.2}",
        median.as_nanos(),
        p95.as_nanos(),
        median.as_nanos() as f64 / operations as f64,
        p95.as_nanos() as f64 / operations as f64,
    );
}
