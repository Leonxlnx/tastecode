use harness_protocol::{DomainEvent, Item, ItemStatus, ItemType, MessageRole, Turn, TurnStatus};
use harness_state::ThreadState;
use std::hint::black_box;
use std::time::{Duration, Instant};

const DELTA_COUNT: usize = 50_000;
const SAMPLES: usize = 11;

fn main() {
    run_stream_workload(100);
    run_stream_workload(1_000);
}

fn run_stream_workload(completed_turns: usize) {
    for _ in 0..2 {
        black_box(measure_stream(completed_turns));
    }
    let mut samples = (0..SAMPLES)
        .map(|_| measure_stream(completed_turns))
        .collect::<Vec<_>>();
    samples.sort_unstable();
    let median = samples[SAMPLES / 2];
    let p95 = samples[((SAMPLES as f64 * 0.95).ceil() as usize - 1).min(SAMPLES - 1)];
    println!(
        "state_stream turns={completed_turns} deltas={DELTA_COUNT} median_ns={} p95_ns={} median_ns_per_delta={:.2} p95_ns_per_delta={:.2}",
        median.as_nanos(),
        p95.as_nanos(),
        median.as_nanos() as f64 / DELTA_COUNT as f64,
        p95.as_nanos() as f64 / DELTA_COUNT as f64,
    );
}

fn measure_stream(completed_turns: usize) -> Duration {
    let (mut state, mut seq, turn_id, item_id) = seeded_state(completed_turns);
    let started = Instant::now();
    for _ in 0..DELTA_COUNT {
        seq += 1;
        black_box(state.apply_live(
            Some(seq),
            DomainEvent::ItemDelta {
                turn_id: turn_id.clone(),
                item_id: item_id.clone(),
                text_delta: "streamed token ".into(),
            },
        ));
    }
    let elapsed = started.elapsed();
    black_box(state.item_at_row(state.timeline_len() - 1));
    elapsed
}

fn seeded_state(completed_turns: usize) -> (ThreadState, u64, String, String) {
    let mut state = ThreadState::default();
    let mut seq = 0_u64;
    for index in 0..completed_turns {
        let turn_id = format!("turn-{index}");
        seq += 1;
        black_box(state.apply_live(
            Some(seq),
            DomainEvent::TurnStarted {
                turn: Turn {
                    id: turn_id.clone(),
                    thread_id: "thread-performance".into(),
                    status: TurnStatus::Running,
                    created_at: index as f64,
                },
            },
        ));
        seq += 1;
        black_box(state.apply_live(
            Some(seq),
            DomainEvent::ItemStarted {
                item: message(
                    format!("item-{index}"),
                    turn_id.clone(),
                    ItemStatus::Completed,
                    "A representative completed response.",
                    index as f64,
                ),
            },
        ));
        seq += 1;
        black_box(state.apply_live(
            Some(seq),
            DomainEvent::TurnCompleted {
                turn_id,
                status: TurnStatus::Completed,
            },
        ));
    }

    let turn_id = "turn-live".to_owned();
    let item_id = "item-live".to_owned();
    seq += 1;
    black_box(state.apply_live(
        Some(seq),
        DomainEvent::TurnStarted {
            turn: Turn {
                id: turn_id.clone(),
                thread_id: "thread-performance".into(),
                status: TurnStatus::Running,
                created_at: completed_turns as f64,
            },
        },
    ));
    seq += 1;
    black_box(state.apply_live(
        Some(seq),
        DomainEvent::ItemStarted {
            item: message(
                item_id.clone(),
                turn_id.clone(),
                ItemStatus::Started,
                "",
                completed_turns as f64,
            ),
        },
    ));
    (state, seq, turn_id, item_id)
}

fn message(id: String, turn_id: String, status: ItemStatus, text: &str, created_at: f64) -> Item {
    Item {
        id,
        turn_id,
        item_type: ItemType::Message,
        status,
        role: Some(MessageRole::Assistant),
        text: Some(text.into()),
        command: None,
        exit_code: None,
        duration_ms: None,
        path: None,
        lines_added: None,
        lines_removed: None,
        created_at,
    }
}
