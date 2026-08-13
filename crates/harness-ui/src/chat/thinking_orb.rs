// Native GPUI port of thinking-orbs 0.1.1 (MIT).
// Copyright (c) 2026 Jakub Antalik. The project notice remains in
// THIRD_PARTY_NOTICES.md; the original implementation is
// https://github.com/Jakubantalik/thinking-orbs.

use crate::theme::{Theme, ThemeMode};
use crate::zoom::px;
use gpui::{
    AnimationExt, AnyElement, Bounds, SharedString, canvas, fill, point, prelude::*, rgba, size,
};
use std::f64::consts::PI;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

const DESIGN_SIZE: f64 = 20.0;
const DOT_SCALE_POWER: f64 = 0.6;
static ORB_CLOCK: OnceLock<Instant> = OnceLock::new();

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ThinkingOrbState {
    Working,
    Searching,
}

pub(super) fn initialize_clock() {
    ORB_CLOCK.get_or_init(Instant::now);
}

#[derive(Clone, Copy, Debug)]
struct Dot {
    x: f64,
    y: f64,
    z: f64,
    radius: f64,
    white: f64,
    alpha: f64,
}

pub(super) fn thinking_orb(state: ThinkingOrbState, theme: Theme) -> AnyElement {
    let elapsed = ORB_CLOCK.get_or_init(Instant::now).elapsed().as_secs_f64();
    let speed = match state {
        ThinkingOrbState::Working => 3.9,
        ThinkingOrbState::Searching => 2.665,
    };
    let time = if theme.reduced_motion {
        0.6
    } else {
        elapsed * speed
    };
    let dark = theme.mode == ThemeMode::Dark;
    let animation_id = match state {
        ThinkingOrbState::Working => "thinking-orb-working",
        ThinkingOrbState::Searching => "thinking-orb-searching",
    };

    canvas(
        move |_bounds, _window, _cx| match state {
            ThinkingOrbState::Working => working_dots(time),
            ThinkingOrbState::Searching => searching_dots(time),
        },
        move |bounds, dots, window, _cx| paint_dots(bounds, dots, dark, window),
    )
    .size(px(DESIGN_SIZE as f32))
    .overflow_hidden()
    .with_animation(
        SharedString::from(animation_id),
        theme.repeating_animation(Duration::from_secs(1)),
        |orb, _delta| orb,
    )
    .into_any_element()
}

fn searching_dots(time: f64) -> Vec<Dot> {
    let center = DESIGN_SIZE / 2.0;
    let radius = DESIGN_SIZE / 2.0 * 0.82;
    let pitch = 0.4 + 0.06 * (time * 0.35).sin();
    let project = Projection::new(time * 0.5, pitch, center, center, radius);
    let scan_angle = time * (0.5 + (1.7 - 0.5) * 4.335);
    let radius_scale = (DESIGN_SIZE / 300.0).powf(DOT_SCALE_POWER);
    let mut dots = Vec::new();

    for ring in 0..=6 {
        let latitude = -PI / 2.0 + ring as f64 / 6.0 * PI;
        let latitude_radius = latitude.cos();
        let vertical = latitude.sin();
        let count = ((latitude_radius.abs() * 14.0).round() as usize).max(1);
        for index in 0..count {
            let longitude = index as f64 / count as f64 * 2.0 * PI;
            let (x, y, z) = project.apply(
                latitude_radius * longitude.cos(),
                vertical,
                latitude_radius * longitude.sin(),
            );
            let depth = (z + 1.0) / 2.0;
            let scan_distance = angle_difference(longitude + time * 0.5, scan_angle);
            let scan = (-(scan_distance * scan_distance) / 0.18).exp() * z.max(0.0);
            dots.push(Dot {
                x,
                y,
                z,
                radius: (1.05 + 2.975 * depth + scan) * radius_scale,
                white: 0.62 - 0.54 * depth,
                alpha: 0.45 + 0.55 * scan.min(1.0),
            });
        }
    }
    dots
}

fn working_dots(time: f64) -> Vec<Dot> {
    let center = DESIGN_SIZE / 2.0;
    let globe_radius = DESIGN_SIZE / 2.0 * 0.82;
    let project = Projection::new(time * 0.12, 0.3, center, center, 1.0);
    let radius_scale = (DESIGN_SIZE / 300.0).powf(DOT_SCALE_POWER);
    let mut dots = Vec::with_capacity(39);

    for orbit in 0..3 {
        let random_radius = pseudo_random(orbit, 1.7);
        let random_axis = pseudo_random(orbit, 5.2);
        let random_speed = pseudo_random(orbit, 8.9);
        let orbit_radius = globe_radius * (0.45 + 0.52 * random_radius);
        let longitude = random_radius * 2.0 * PI;
        let latitude = (2.0 * random_axis - 1.0).acos();
        let axis_x = latitude.sin() * longitude.cos();
        let axis_y = latitude.cos();
        let axis_z = latitude.sin() * longitude.sin();

        let mut basis_x = -axis_y;
        let mut basis_y = axis_x;
        let basis_z = 0.0;
        let basis_length = (basis_x * basis_x + basis_y * basis_y).sqrt().max(1e-6);
        basis_x /= basis_length;
        basis_y /= basis_length;
        let tangent_x = axis_y * basis_z - axis_z * basis_y;
        let tangent_y = axis_z * basis_x - axis_x * basis_z;
        let tangent_z = axis_x * basis_y - axis_y * basis_x;
        let angular_speed =
            (0.25 + 0.55 * random_speed) * if random_speed > 0.5 { 1.0 } else { -1.0 };

        for index in 0..10 {
            let angle = index as f64 / 10.0 * 2.0 * PI;
            let (x, y, z) = project.apply(
                (basis_x * angle.cos() + tangent_x * angle.sin()) * orbit_radius,
                (basis_y * angle.cos() + tangent_y * angle.sin()) * orbit_radius,
                (basis_z * angle.cos() + tangent_z * angle.sin()) * orbit_radius,
            );
            let depth = (z / orbit_radius + 1.0) / 2.0;
            dots.push(Dot {
                x,
                y,
                z,
                radius: 2.16 * radius_scale,
                white: 0.72,
                alpha: 0.5 * (0.4 + 0.6 * depth),
            });
        }

        for particle in 0..3 {
            let angle = time * angular_speed + particle as f64 / 3.0 * 2.0 * PI + random_axis * 6.0;
            let (x, y, z) = project.apply(
                (basis_x * angle.cos() + tangent_x * angle.sin()) * orbit_radius,
                (basis_y * angle.cos() + tangent_y * angle.sin()) * orbit_radius,
                (basis_z * angle.cos() + tangent_z * angle.sin()) * orbit_radius,
            );
            let depth = (z / orbit_radius + 1.0) / 2.0;
            dots.push(Dot {
                x,
                y,
                z,
                radius: (2.88 + 3.84 * depth) * radius_scale,
                white: 0.3 - 0.22 * depth,
                alpha: 1.0,
            });
        }
    }
    dots
}

fn paint_dots(
    bounds: Bounds<gpui::Pixels>,
    mut dots: Vec<Dot>,
    dark: bool,
    window: &mut gpui::Window,
) {
    dots.sort_by(|left, right| left.z.total_cmp(&right.z));
    let scale = (f64::from(bounds.size.width) / DESIGN_SIZE)
        .min(f64::from(bounds.size.height) / DESIGN_SIZE);
    let inset_x = (f64::from(bounds.size.width) - DESIGN_SIZE * scale) / 2.0;
    let inset_y = (f64::from(bounds.size.height) - DESIGN_SIZE * scale) / 2.0;

    for dot in dots {
        if dot.alpha < 0.02 {
            continue;
        }
        let white = dot.white.clamp(0.0, 1.0);
        let value = ((if dark { 1.0 - white } else { white }) * 255.0).round() as u32;
        let alpha = (dot.alpha.clamp(0.0, 1.0) * 255.0).round() as u32;
        let color = rgba((value << 24) | (value << 16) | (value << 8) | alpha);
        let radius = dot.radius.max(0.3) * scale;
        let center_x = f64::from(bounds.origin.x) + inset_x + dot.x * scale;
        let center_y = f64::from(bounds.origin.y) + inset_y + dot.y * scale;
        let radius_px = gpui::px(radius as f32);
        let dot_bounds = Bounds {
            origin: point(
                gpui::px((center_x - radius) as f32),
                gpui::px((center_y - radius) as f32),
            ),
            size: size(radius_px * 2.0, radius_px * 2.0),
        };
        window.paint_quad(fill(dot_bounds, color).corner_radii(radius_px));
    }
}

#[derive(Clone, Copy)]
struct Projection {
    sin_pitch: f64,
    cos_pitch: f64,
    sin_yaw: f64,
    cos_yaw: f64,
    center_x: f64,
    center_y: f64,
    radius: f64,
}

impl Projection {
    fn new(yaw: f64, pitch: f64, center_x: f64, center_y: f64, radius: f64) -> Self {
        Self {
            sin_pitch: pitch.sin(),
            cos_pitch: pitch.cos(),
            sin_yaw: yaw.sin(),
            cos_yaw: yaw.cos(),
            center_x,
            center_y,
            radius,
        }
    }

    fn apply(self, x: f64, y: f64, z: f64) -> (f64, f64, f64) {
        let horizontal = x * self.cos_yaw + z * self.sin_yaw;
        let depth = -x * self.sin_yaw + z * self.cos_yaw;
        let vertical = y * self.cos_pitch - depth * self.sin_pitch;
        let projected_depth = y * self.sin_pitch + depth * self.cos_pitch;
        (
            self.center_x + horizontal * self.radius,
            self.center_y - vertical * self.radius,
            projected_depth,
        )
    }
}

fn pseudo_random(index: usize, seed: f64) -> f64 {
    let value = ((index as f64 * 12.9898 + seed * 78.233).sin()) * 43_758.545_3;
    value - value.floor()
}

fn angle_difference(left: f64, right: f64) -> f64 {
    (left - right).sin().atan2((left - right).cos())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inline_presets_keep_the_package_dot_counts() {
        assert_eq!(working_dots(0.0).len(), 39);
        assert_eq!(searching_dots(0.0).len(), 54);
    }

    #[test]
    fn package_random_function_is_stable() {
        assert!((pseudo_random(0, 1.7) - 0.934_379_185_891_884_8).abs() < 1e-10);
        assert!((pseudo_random(2, 8.9) - 0.690_018_712_417_440_8).abs() < 1e-10);
    }

    #[test]
    fn fixed_frames_match_thinking_orbs_0_1_1() {
        let mut working = working_dots(1.234);
        working.sort_by(|left, right| left.z.total_cmp(&right.z));
        assert_dot(
            working[0],
            (
                10.689_891_936_667_848,
                9.919_134_785_146_57,
                0.425_401_479_225_04,
            ),
        );
        assert_dot(
            working[19],
            (
                8.249_135_486_261_604,
                6.786_753_720_956_714,
                0.425_401_479_225_04,
            ),
        );
        assert_dot(
            working[38],
            (
                9.310_108_063_332_152,
                10.080_865_214_853_43,
                0.425_401_479_225_04,
            ),
        );

        let mut searching = searching_dots(1.234);
        searching.sort_by(|left, right| left.z.total_cmp(&right.z));
        assert_dot(
            searching[0],
            (9.337_683_734_305_36, 10.819_021_285_637_808, 0.3),
        );
        assert_dot(
            searching[27],
            (
                6.943_136_398_494_412,
                2.403_799_596_484_151,
                0.515_456_654_534_372_6,
            ),
        );
        assert_dot(
            searching[53],
            (
                10.662_316_265_694_642,
                9.180_978_714_362_192,
                0.790_277_209_504_405_7,
            ),
        );
    }

    fn assert_dot(dot: Dot, expected: (f64, f64, f64)) {
        assert!((dot.x - expected.0).abs() < 1e-10, "x was {}", dot.x);
        assert!((dot.y - expected.1).abs() < 1e-10, "y was {}", dot.y);
        assert!(
            (dot.radius.max(0.3) - expected.2).abs() < 1e-10,
            "radius was {}",
            dot.radius
        );
    }
}
