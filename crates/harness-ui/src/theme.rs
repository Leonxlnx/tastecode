use gpui::{Animation, Hsla, rgb};
use gpui_component::highlighter::{HighlightTheme, LanguageConfig, LanguageRegistry};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::sync::{Arc, Once, OnceLock};
use std::time::Duration;

pub const RAIL_WIDTH: f32 = 248.0;
pub const CHAT_WIDTH: f32 = 808.0;
pub const TITLEBAR_HEIGHT: f32 = 34.0;
pub const BASE_LINE_HEIGHT: f32 = 1.55;
pub const RADIUS_SM: f32 = 3.0;
pub const RADIUS_MD: f32 = 5.0;
pub const RADIUS_LG: f32 = 8.0;
pub const RADIUS_XL: f32 = 10.0;
pub const RADIUS_2XL: f32 = 20.0;
pub const RAIL_FOLD_DURATION: Duration = Duration::from_millis(380);
pub const RAIL_REVEAL_DURATION: Duration = Duration::from_millis(160);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Motion {
    pub press: Duration,
    pub fast: Duration,
    pub slow: Duration,
}

impl Motion {
    pub const WEB_PARITY: Self = Self {
        press: Duration::from_millis(140),
        fast: Duration::from_millis(180),
        slow: Duration::from_millis(260),
    };

    pub const REDUCED: Self = Self {
        press: Duration::from_micros(10),
        fast: Duration::from_micros(10),
        slow: Duration::from_micros(10),
    };
}

/// The CSS `cubic-bezier(0.23, 1, 0.32, 1)` timing function used throughout
/// the web oracle. GPUI accepts elapsed progress, so solve the Bezier's x
/// coordinate and return its y coordinate.
pub(crate) fn web_ease_out(progress: f32) -> f32 {
    cubic_bezier_timing(progress, 0.23, 1.0, 0.32, 1.0)
}

/// The CSS `cubic-bezier(0.32, 0.72, 0, 1)` timing function used for the
/// sidebar's large layout and flyout motion.
pub(crate) fn web_ease_rail(progress: f32) -> f32 {
    cubic_bezier_timing(progress, 0.32, 0.72, 0.0, 1.0)
}

pub(crate) fn cubic_bezier_timing(progress: f32, x1: f32, y1: f32, x2: f32, y2: f32) -> f32 {
    let progress = progress.clamp(0.0, 1.0);
    if progress == 0.0 || progress == 1.0 {
        return progress;
    }

    let mut lower = 0.0;
    let mut upper = 1.0;
    for _ in 0..16 {
        let parameter = (lower + upper) * 0.5;
        if bezier_component(parameter, x1, x2) < progress {
            lower = parameter;
        } else {
            upper = parameter;
        }
    }
    bezier_component((lower + upper) * 0.5, y1, y2)
}

fn bezier_component(parameter: f32, first: f32, second: f32) -> f32 {
    let inverse = 1.0 - parameter;
    3.0 * inverse * inverse * parameter * first
        + 3.0 * inverse * parameter * parameter * second
        + parameter * parameter * parameter
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ColorToken(pub u32);

impl ColorToken {
    pub fn hsla(self) -> Hsla {
        rgb(self.0).into()
    }

    pub fn mix_srgb(self, other: Self, weight: f32) -> Self {
        let weight = weight.clamp(0.0, 1.0);
        let other_weight = 1.0 - weight;
        let channel = |shift: u32| {
            let first = ((self.0 >> shift) & 0xff_u32) as f32;
            let second = ((other.0 >> shift) & 0xff_u32) as f32;
            (first * weight + second * other_weight).round() as u32
        };
        Self((channel(16) << 16) | (channel(8) << 8) | channel(0))
    }

    pub fn mix_oklab(self, other: Self, weight: f32) -> Self {
        let weight = f64::from(weight.clamp(0.0, 1.0));
        let first = token_to_oklab(self);
        let second = token_to_oklab(other);
        let mixed = [
            first[0] * weight + second[0] * (1.0 - weight),
            first[1] * weight + second[1] * (1.0 - weight),
            first[2] * weight + second[2] * (1.0 - weight),
        ];
        oklab_to_token(mixed)
    }
}

fn token_to_oklab(color: ColorToken) -> [f64; 3] {
    let channel = |shift: u32| {
        let channel = f64::from((color.0 >> shift) & 0xff_u32) / 255.0;
        if channel <= 0.04045 {
            channel / 12.92
        } else {
            ((channel + 0.055) / 1.055).powf(2.4)
        }
    };
    let red = channel(16);
    let green = channel(8);
    let blue = channel(0);
    let long = (0.412_221_470_8 * red + 0.536_332_536_3 * green + 0.051_445_992_9 * blue).cbrt();
    let medium = (0.211_903_498_2 * red + 0.680_699_545_1 * green + 0.107_396_956_6 * blue).cbrt();
    let short = (0.088_302_461_9 * red + 0.281_718_837_6 * green + 0.629_978_700_5 * blue).cbrt();
    [
        0.210_454_255_3 * long + 0.793_617_785 * medium - 0.004_072_046_8 * short,
        1.977_998_495_1 * long - 2.428_592_205 * medium + 0.450_593_709_9 * short,
        0.025_904_037_1 * long + 0.782_771_766_2 * medium - 0.808_675_766 * short,
    ]
}

fn oklab_to_token(color: [f64; 3]) -> ColorToken {
    let [lightness, green_red, blue_yellow] = color;
    let long = (lightness + 0.396_337_777_4 * green_red + 0.215_803_757_3 * blue_yellow).powi(3);
    let medium = (lightness - 0.105_561_345_8 * green_red - 0.063_854_172_8 * blue_yellow).powi(3);
    let short = (lightness - 0.089_484_177_5 * green_red - 1.291_485_548 * blue_yellow).powi(3);
    let linear = [
        4.076_741_662_1 * long - 3.307_711_591_3 * medium + 0.230_969_929_2 * short,
        -1.268_438_004_6 * long + 2.609_757_401_1 * medium - 0.341_319_396_5 * short,
        -0.004_196_086_3 * long - 0.703_418_614_7 * medium + 1.707_614_701 * short,
    ];
    let channel = |channel: f64| {
        let srgb = if channel <= 0.003_130_8 {
            12.92 * channel
        } else {
            1.055 * channel.powf(1.0 / 2.4) - 0.055
        };
        (srgb.clamp(0.0, 1.0) * 255.0).round() as u32
    };
    ColorToken((channel(linear[0]) << 16) | (channel(linear[1]) << 8) | channel(linear[2]))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThemeMode {
    Dark,
    Light,
}

#[derive(Clone, Copy)]
#[repr(usize)]
enum GithubHighlightVariant {
    General,
    StructuredData,
    Stylesheet,
    Diff,
    Python,
    Toml,
}

#[derive(Clone, Copy)]
struct GithubHighlightPalette {
    foreground: &'static str,
    background: &'static str,
    comment: &'static str,
    constant: &'static str,
    entity: &'static str,
    function: &'static str,
    tag: &'static str,
    keyword: &'static str,
    string: &'static str,
    invalid: &'static str,
}

impl GithubHighlightPalette {
    const DARK: Self = Self {
        foreground: "#e6edf3",
        background: "#0d1117",
        comment: "#8b949e",
        constant: "#79c0ff",
        entity: "#ffa657",
        function: "#d2a8ff",
        tag: "#7ee787",
        keyword: "#ff7b72",
        string: "#a5d6ff",
        invalid: "#ffa198",
    };

    const LIGHT: Self = Self {
        foreground: "#1f2328",
        background: "#ffffff",
        comment: "#6e7781",
        constant: "#0550ae",
        entity: "#953800",
        function: "#8250df",
        tag: "#116329",
        keyword: "#cf222e",
        string: "#0a3069",
        invalid: "#82071e",
    };
}

pub(crate) fn native_syntax_language(language: &str) -> Cow<'_, str> {
    register_native_syntax_languages();
    if language.eq_ignore_ascii_case("jsx") {
        Cow::Borrowed("jsx")
    } else if ["shell", "zsh", "fish"]
        .iter()
        .any(|alias| language.eq_ignore_ascii_case(alias))
    {
        Cow::Borrowed("bash")
    } else if language.bytes().any(|byte| byte.is_ascii_uppercase()) {
        Cow::Owned(language.to_ascii_lowercase())
    } else {
        Cow::Borrowed(language)
    }
}

pub(crate) fn register_native_syntax_languages() {
    static REGISTER: Once = Once::new();
    REGISTER.call_once(|| {
        let injection_languages: Vec<gpui::SharedString> = [
            "jsdoc",
            "json",
            "css",
            "html",
            "sql",
            "typescript",
            "javascript",
            "tsx",
            "yaml",
            "graphql",
        ]
        .into_iter()
        .map(Into::into)
        .collect();
        let javascript_highlights = format!(
            "{}\n{}",
            tree_sitter_javascript::HIGHLIGHT_QUERY,
            tree_sitter_javascript::JSX_HIGHLIGHT_QUERY,
        );
        let typescript_highlights = format!(
            "{javascript_highlights}\n{}",
            tree_sitter_typescript::HIGHLIGHTS_QUERY,
        );
        let registry = LanguageRegistry::singleton();
        registry.register(
            "jsx",
            &LanguageConfig::new(
                "jsx",
                tree_sitter_javascript::LANGUAGE.into(),
                injection_languages.clone(),
                &javascript_highlights,
                tree_sitter_javascript::INJECTIONS_QUERY,
                tree_sitter_javascript::LOCALS_QUERY,
            ),
        );
        registry.register(
            "tsx",
            &LanguageConfig::new(
                "tsx",
                tree_sitter_typescript::LANGUAGE_TSX.into(),
                injection_languages,
                &typescript_highlights,
                tree_sitter_javascript::INJECTIONS_QUERY,
                tree_sitter_typescript::LOCALS_QUERY,
            ),
        );
    });
}

pub(crate) fn github_highlight_theme(mode: ThemeMode) -> Arc<HighlightTheme> {
    github_highlight_theme_for_variant(mode, GithubHighlightVariant::General)
}

pub(crate) fn github_highlight_theme_for_language(
    mode: ThemeMode,
    language: &str,
) -> Arc<HighlightTheme> {
    let variant = match language.to_ascii_lowercase().as_str() {
        "json" | "jsonc" | "yaml" | "yml" => GithubHighlightVariant::StructuredData,
        "css" | "scss" => GithubHighlightVariant::Stylesheet,
        "diff" | "patch" => GithubHighlightVariant::Diff,
        "python" | "py" => GithubHighlightVariant::Python,
        "toml" => GithubHighlightVariant::Toml,
        _ => GithubHighlightVariant::General,
    };
    github_highlight_theme_for_variant(mode, variant)
}

fn github_highlight_theme_for_variant(
    mode: ThemeMode,
    variant: GithubHighlightVariant,
) -> Arc<HighlightTheme> {
    static DARK: [OnceLock<Arc<HighlightTheme>>; 6] = [const { OnceLock::new() }; 6];
    static LIGHT: [OnceLock<Arc<HighlightTheme>>; 6] = [const { OnceLock::new() }; 6];

    let cache = match mode {
        ThemeMode::Dark => &DARK,
        ThemeMode::Light => &LIGHT,
    };
    cache[variant as usize]
        .get_or_init(|| Arc::new(build_github_highlight_theme(mode, variant)))
        .clone()
}

fn build_github_highlight_theme(
    mode: ThemeMode,
    variant: GithubHighlightVariant,
) -> HighlightTheme {
    let palette = match mode {
        ThemeMode::Dark => GithubHighlightPalette::DARK,
        ThemeMode::Light => GithubHighlightPalette::LIGHT,
    };
    let property = match variant {
        GithubHighlightVariant::StructuredData => palette.tag,
        GithubHighlightVariant::Stylesheet => palette.constant,
        GithubHighlightVariant::Toml => palette.entity,
        _ => palette.foreground,
    };
    let type_color = match variant {
        GithubHighlightVariant::Python => palette.constant,
        GithubHighlightVariant::Toml => palette.foreground,
        _ => palette.entity,
    };
    let string = match variant {
        GithubHighlightVariant::Diff => palette.tag,
        _ => palette.string,
    };
    let keyword = match variant {
        GithubHighlightVariant::Diff => palette.invalid,
        _ => palette.keyword,
    };
    let (appearance, name) = match mode {
        ThemeMode::Dark => ("dark", "GitHub Dark Default"),
        ThemeMode::Light => ("light", "GitHub Light Default"),
    };

    let syntax = serde_json::Map::from_iter([
        (
            "attribute".into(),
            highlight_style(palette.constant, None, None),
        ),
        (
            "boolean".into(),
            highlight_style(palette.constant, None, None),
        ),
        (
            "comment".into(),
            highlight_style(palette.comment, None, None),
        ),
        (
            "comment.doc".into(),
            highlight_style(palette.comment, None, None),
        ),
        (
            "constant".into(),
            highlight_style(palette.constant, None, None),
        ),
        (
            "constructor".into(),
            highlight_style(palette.entity, None, None),
        ),
        (
            "embedded".into(),
            highlight_style(palette.foreground, None, None),
        ),
        (
            "emphasis".into(),
            highlight_style(palette.foreground, Some("italic"), None),
        ),
        (
            "emphasis.strong".into(),
            highlight_style(palette.foreground, None, Some(700)),
        ),
        ("enum".into(), highlight_style(palette.entity, None, None)),
        (
            "function".into(),
            highlight_style(palette.function, None, None),
        ),
        ("hint".into(), highlight_style(palette.comment, None, None)),
        ("keyword".into(), highlight_style(keyword, None, None)),
        ("label".into(), highlight_style(palette.entity, None, None)),
        (
            "link_text".into(),
            highlight_style(palette.constant, None, None),
        ),
        (
            "link_uri".into(),
            highlight_style(palette.string, None, None),
        ),
        (
            "number".into(),
            highlight_style(palette.constant, None, None),
        ),
        (
            "operator".into(),
            highlight_style(palette.keyword, None, None),
        ),
        (
            "predictive".into(),
            highlight_style(palette.comment, None, None),
        ),
        (
            "preproc".into(),
            highlight_style(palette.keyword, None, None),
        ),
        (
            "primary".into(),
            highlight_style(palette.foreground, None, None),
        ),
        ("property".into(), highlight_style(property, None, None)),
        (
            "punctuation".into(),
            highlight_style(palette.foreground, None, None),
        ),
        (
            "punctuation.bracket".into(),
            highlight_style(palette.foreground, None, None),
        ),
        (
            "punctuation.delimiter".into(),
            highlight_style(palette.foreground, None, None),
        ),
        (
            "punctuation.list_marker".into(),
            highlight_style(palette.entity, None, None),
        ),
        (
            "punctuation.special".into(),
            highlight_style(palette.keyword, None, None),
        ),
        ("string".into(), highlight_style(string, None, None)),
        (
            "string.escape".into(),
            highlight_style(palette.tag, None, None),
        ),
        (
            "string.regex".into(),
            highlight_style(palette.string, None, None),
        ),
        (
            "string.special".into(),
            highlight_style(palette.string, None, None),
        ),
        (
            "string.special.symbol".into(),
            highlight_style(palette.constant, None, None),
        ),
        ("tag".into(), highlight_style(palette.tag, None, None)),
        (
            "tag.doctype".into(),
            highlight_style(palette.constant, None, None),
        ),
        (
            "text.literal".into(),
            highlight_style(palette.constant, None, None),
        ),
        (
            "title".into(),
            highlight_style(palette.constant, None, Some(700)),
        ),
        ("type".into(), highlight_style(type_color, None, None)),
        (
            "variable".into(),
            highlight_style(palette.foreground, None, None),
        ),
        (
            "variable.special".into(),
            highlight_style(palette.constant, None, None),
        ),
        (
            "variant".into(),
            highlight_style(palette.entity, None, None),
        ),
    ]);

    serde_json::from_value(serde_json::json!({
        "name": name,
        "appearance": appearance,
        "style": {
            "editor.background": palette.background,
            "editor.foreground": palette.foreground,
            "syntax": syntax
        }
    }))
    .expect("the built-in GitHub highlight theme must be valid")
}

fn highlight_style(
    color: &'static str,
    font_style: Option<&'static str>,
    font_weight: Option<u16>,
) -> serde_json::Value {
    let mut style = serde_json::Map::new();
    style.insert("color".into(), color.into());
    if let Some(font_style) = font_style {
        style.insert("font_style".into(), font_style.into());
    }
    if let Some(font_weight) = font_weight {
        style.insert("font_weight".into(), font_weight.into());
    }
    style.into()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Backdrop {
    Default,
    Slate,
    Mocha,
    Forest,
    Midnight,
    Plum,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Accent {
    Neutral,
    Ocean,
    Forest,
    Sunset,
    Amber,
    Rose,
    Lavender,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Theme {
    pub mode: ThemeMode,
    pub background: ColorToken,
    pub rail: ColorToken,
    pub prompt: ColorToken,
    pub shelf: ColorToken,
    pub surface: ColorToken,
    pub surface_2: ColorToken,
    pub surface_3: ColorToken,
    pub queue_background: ColorToken,
    pub queue_line: ColorToken,
    pub queue_text: ColorToken,
    pub queue_action: ColorToken,
    pub queue_hover: ColorToken,
    pub composer_placeholder: ColorToken,
    pub composer_review: ColorToken,
    pub composer_danger: ColorToken,
    pub composer_orb: ColorToken,
    pub composer_on_orb: ColorToken,
    pub composer_stop: ColorToken,
    pub line: ColorToken,
    pub line_strong: ColorToken,
    pub text: ColorToken,
    pub response_text: ColorToken,
    pub text_2: ColorToken,
    pub text_3: ColorToken,
    pub titlebar: ColorToken,
    pub titlebar_symbol: ColorToken,
    pub running: ColorToken,
    pub attention: ColorToken,
    pub file_reference: ColorToken,
    pub effort: ColorToken,
    pub error: ColorToken,
    pub success: ColorToken,
    pub motion: Motion,
    pub reduced_motion: bool,
}

impl Theme {
    pub fn new(mode: ThemeMode, backdrop: Backdrop, accent: Accent) -> Self {
        let mut theme = match mode {
            ThemeMode::Dark => Self::dark(),
            ThemeMode::Light => Self::light(),
        };
        theme.apply_backdrop(backdrop);
        theme.apply_accent(accent);
        theme
    }

    pub fn dark() -> Self {
        Self {
            mode: ThemeMode::Dark,
            background: ColorToken(0x0f0f0f),
            rail: ColorToken(0x131313),
            prompt: ColorToken(0x1a1a1a),
            shelf: ColorToken(0x222222),
            surface: ColorToken(0x1a1a1a),
            surface_2: ColorToken(0x222222),
            surface_3: ColorToken(0x2b2b2b),
            queue_background: ColorToken(0x222222),
            queue_line: ColorToken(0x2b2b2b),
            queue_text: ColorToken(0xededed),
            queue_action: ColorToken(0x8a8a8a),
            queue_hover: ColorToken(0x2b2b2b),
            composer_placeholder: ColorToken(0x6f6f6f),
            composer_review: ColorToken(0x65b8ff),
            composer_danger: ColorToken(0xfe8549),
            composer_orb: ColorToken(0xededed),
            composer_on_orb: ColorToken(0x101010),
            composer_stop: ColorToken(0x2b2b2b),
            line: ColorToken(0x262626),
            line_strong: ColorToken(0x333333),
            text: ColorToken(0xededed),
            response_text: ColorToken(0xfefefe),
            text_2: ColorToken(0xa3a3a3),
            text_3: ColorToken(0x6f6f6f),
            titlebar: ColorToken(0x151515),
            titlebar_symbol: ColorToken(0xf4f4f5),
            running: ColorToken(0xd4d4d4),
            attention: ColorToken(0x4c9dff),
            file_reference: ColorToken(0x515aad),
            effort: ColorToken(0xef706e),
            error: ColorToken(0xe5687a),
            success: ColorToken(0x6fbf8e),
            motion: Motion::WEB_PARITY,
            reduced_motion: false,
        }
    }

    pub fn light() -> Self {
        Self {
            mode: ThemeMode::Light,
            background: ColorToken(0xfdfdfd),
            rail: ColorToken(0xffffff),
            prompt: ColorToken(0xffffff),
            shelf: ColorToken(0xfafafa),
            surface: ColorToken(0xfafafa),
            surface_2: ColorToken(0xf5f5f6),
            surface_3: ColorToken(0xececef),
            queue_background: ColorToken(0xffffff),
            queue_line: ColorToken(0xeeeeef),
            queue_text: ColorToken(0x18181b),
            queue_action: ColorToken(0x96969a),
            queue_hover: ColorToken(0xf5f5f6),
            composer_placeholder: ColorToken(0xc7c7ca),
            composer_review: ColorToken(0x2d72dc),
            composer_danger: ColorToken(0xef4d05),
            composer_orb: ColorToken(0x1d1d1f),
            composer_on_orb: ColorToken(0xffffff),
            composer_stop: ColorToken(0x1d1d1f),
            line: ColorToken(0xebebed),
            line_strong: ColorToken(0xdedee2),
            text: ColorToken(0x27272a),
            response_text: ColorToken(0x18181b),
            text_2: ColorToken(0x52525b),
            text_3: ColorToken(0x71717a),
            titlebar: ColorToken(0xffffff),
            titlebar_symbol: ColorToken(0x27272a),
            running: ColorToken(0x52525b),
            attention: ColorToken(0x2563eb),
            file_reference: ColorToken(0x4a53a8),
            effort: ColorToken(0xc2413d),
            error: ColorToken(0xbe123c),
            success: ColorToken(0x16803c),
            motion: Motion::WEB_PARITY,
            reduced_motion: false,
        }
    }

    pub fn with_reduced_motion(mut self, reduced: bool) -> Self {
        self.reduced_motion = reduced;
        self.motion = if reduced {
            Motion::REDUCED
        } else {
            Motion::WEB_PARITY
        };
        self
    }

    pub fn motion_duration(self, duration: Duration) -> Duration {
        if self.reduced_motion {
            Motion::REDUCED.fast
        } else {
            duration
        }
    }

    pub fn repeating_animation(self, duration: Duration) -> Animation {
        let animation = Animation::new(self.motion_duration(duration));
        if self.reduced_motion {
            animation
        } else {
            animation.repeat()
        }
    }

    fn apply_backdrop(&mut self, backdrop: Backdrop) {
        let colors = match (self.mode, backdrop) {
            (_, Backdrop::Default) => return,
            (ThemeMode::Dark, Backdrop::Slate) => {
                [0x0e1013, 0x12151a, 0x191d24, 0x191d24, 0x20242c, 0x292e37]
            }
            (ThemeMode::Dark, Backdrop::Mocha) => {
                [0x121010, 0x161312, 0x1c1817, 0x1c1817, 0x241f1d, 0x2d2725]
            }
            (ThemeMode::Dark, Backdrop::Forest) => {
                [0x0e120f, 0x121713, 0x181f1a, 0x181f1a, 0x202822, 0x29322b]
            }
            (ThemeMode::Dark, Backdrop::Midnight) => {
                [0x0b0d14, 0x0e1119, 0x141828, 0x141828, 0x1b2030, 0x232939]
            }
            (ThemeMode::Dark, Backdrop::Plum) => {
                [0x120f13, 0x161217, 0x1d181e, 0x1d181e, 0x251f26, 0x2e2730]
            }
            (ThemeMode::Light, Backdrop::Slate) => {
                [0xf7f9fc, 0xf2f5f9, 0xfbfcfe, 0xeef2f7, 0xe3e9f1, 0xd7dfe9]
            }
            (ThemeMode::Light, Backdrop::Mocha) => {
                [0xfcfaf8, 0xf7f4f0, 0xfefdfb, 0xf4f0eb, 0xebe5de, 0xe0d9d0]
            }
            (ThemeMode::Light, Backdrop::Forest) => {
                [0xf8fbf8, 0xf2f7f2, 0xfcfefc, 0xeef4ee, 0xe3ece3, 0xd6e2d6]
            }
            (ThemeMode::Light, Backdrop::Midnight) => {
                [0xf5f7fc, 0xeff2f9, 0xfafbfe, 0xebeef7, 0xdfe4f0, 0xd2d9e8]
            }
            (ThemeMode::Light, Backdrop::Plum) => {
                [0xfbf8fc, 0xf6f2f7, 0xfdfcfe, 0xf3eef4, 0xeae2ec, 0xded4e0]
            }
        };
        self.background = ColorToken(colors[0]);
        self.rail = ColorToken(colors[1]);
        self.prompt = ColorToken(colors[2]);
        self.surface = ColorToken(colors[3]);
        self.surface_2 = ColorToken(colors[4]);
        self.surface_3 = ColorToken(colors[5]);
    }

    fn apply_accent(&mut self, accent: Accent) {
        self.attention = ColorToken(match (self.mode, accent) {
            (ThemeMode::Dark, Accent::Neutral) => 0x4c9dff,
            (ThemeMode::Dark, Accent::Ocean) => 0x65b8ff,
            (ThemeMode::Dark, Accent::Forest) => 0x71c695,
            (ThemeMode::Dark, Accent::Sunset) => 0xc69cff,
            (ThemeMode::Dark, Accent::Amber) => 0xe0ad61,
            (ThemeMode::Dark, Accent::Rose) => 0xe593ad,
            (ThemeMode::Dark, Accent::Lavender) => 0xae9eea,
            (ThemeMode::Light, Accent::Neutral) => 0x2563eb,
            (ThemeMode::Light, Accent::Ocean) => 0x1677be,
            (ThemeMode::Light, Accent::Forest) => 0x247b4f,
            (ThemeMode::Light, Accent::Sunset) => 0x7e4bc2,
            (ThemeMode::Light, Accent::Amber) => 0x936017,
            (ThemeMode::Light, Accent::Rose) => 0xa34264,
            (ThemeMode::Light, Accent::Lavender) => 0x6653aa,
        });
        self.file_reference = ColorToken(match (self.mode, accent) {
            (ThemeMode::Dark, Accent::Neutral) => 0x515aad,
            (ThemeMode::Dark, Accent::Ocean) => 0x62abc7,
            (ThemeMode::Dark, Accent::Forest) => 0x62aa84,
            (ThemeMode::Dark, Accent::Sunset) => 0xb58ad5,
            (ThemeMode::Dark, Accent::Amber) => 0xc18e50,
            (ThemeMode::Dark, Accent::Rose) => 0xc77f9e,
            (ThemeMode::Dark, Accent::Lavender) => 0x9385c8,
            (ThemeMode::Light, Accent::Neutral) => 0x4a53a8,
            (ThemeMode::Light, Accent::Ocean) => 0x247b99,
            (ThemeMode::Light, Accent::Forest) => 0x2f7658,
            (ThemeMode::Light, Accent::Sunset) => 0x8455a8,
            (ThemeMode::Light, Accent::Amber) => 0x845b24,
            (ThemeMode::Light, Accent::Rose) => 0x934b6a,
            (ThemeMode::Light, Accent::Lavender) => 0x675896,
        });
        self.effort = ColorToken(match (self.mode, accent) {
            (ThemeMode::Dark, Accent::Neutral) => 0xef706e,
            (ThemeMode::Dark, Accent::Ocean) => 0x74b8cf,
            (ThemeMode::Dark, Accent::Forest) => 0x8bc47a,
            (ThemeMode::Dark, Accent::Sunset) => 0xe58c76,
            (ThemeMode::Dark, Accent::Amber) => 0xdf985d,
            (ThemeMode::Dark, Accent::Rose) => 0xdf8294,
            (ThemeMode::Dark, Accent::Lavender) => 0xc49ad8,
            (ThemeMode::Light, Accent::Neutral) => 0xc2413d,
            (ThemeMode::Light, Accent::Ocean) => 0x287f99,
            (ThemeMode::Light, Accent::Forest) => 0x4c7f3d,
            (ThemeMode::Light, Accent::Sunset) => 0xb15442,
            (ThemeMode::Light, Accent::Amber) => 0xa55a27,
            (ThemeMode::Light, Accent::Rose) => 0xad4657,
            (ThemeMode::Light, Accent::Lavender) => 0x81548f,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn primary_geometry_and_motion_match_the_css_contract() {
        assert_eq!(RAIL_WIDTH, 248.0);
        assert_eq!(CHAT_WIDTH, 808.0);
        assert_eq!(TITLEBAR_HEIGHT, 34.0);
        assert_eq!(BASE_LINE_HEIGHT, 1.55);
        assert_eq!(RADIUS_SM, 3.0);
        assert_eq!(RADIUS_MD, 5.0);
        assert_eq!(RADIUS_LG, 8.0);
        assert_eq!(RADIUS_XL, 10.0);
        assert_eq!(RADIUS_2XL, 20.0);
        assert_eq!(RAIL_FOLD_DURATION, Duration::from_millis(380));
        assert_eq!(RAIL_REVEAL_DURATION, Duration::from_millis(160));
        assert_eq!(Motion::WEB_PARITY.press, Duration::from_millis(140));
        assert_eq!(Motion::WEB_PARITY.fast, Duration::from_millis(180));
        assert_eq!(Motion::WEB_PARITY.slow, Duration::from_millis(260));
        assert_eq!(Motion::REDUCED.press, Duration::from_micros(10));
        assert_eq!(Motion::REDUCED.fast, Duration::from_micros(10));
        assert_eq!(Motion::REDUCED.slow, Duration::from_micros(10));
        assert!((web_ease_out(0.157_656_25) - 0.578_125).abs() < 0.000_1);
        assert!((web_ease_out(0.331_25) - 0.875).abs() < 0.000_1);
        assert!(web_ease_rail(0.5) > 0.8);
        assert!(cubic_bezier_timing(0.48, 0.2, 1.6, 0.4, 1.0) > 1.0);
    }

    #[test]
    fn reduced_motion_collapses_every_animation_duration() {
        let theme = Theme::dark().with_reduced_motion(true);

        assert!(theme.reduced_motion);
        assert_eq!(theme.motion, Motion::REDUCED);
        assert_eq!(
            theme.motion_duration(Duration::from_secs(30)),
            Duration::from_micros(10)
        );
        assert!(theme.repeating_animation(Duration::from_secs(1)).oneshot);
        assert!(
            !Theme::dark()
                .repeating_animation(Duration::from_secs(1))
                .oneshot
        );
    }

    #[test]
    fn neutral_theme_tokens_match_the_web_oracle() {
        let dark = Theme::dark();
        let light = Theme::light();

        assert_eq!(dark.background, ColorToken(0x0f0f0f));
        assert_eq!(dark.rail, ColorToken(0x131313));
        assert_eq!(dark.shelf, ColorToken(0x222222));
        assert_eq!(dark.text, ColorToken(0xededed));
        assert_eq!(dark.queue_background, ColorToken(0x222222));
        assert_eq!(dark.queue_line, ColorToken(0x2b2b2b));
        assert_eq!(dark.queue_action, ColorToken(0x8a8a8a));
        assert_eq!(dark.composer_placeholder, ColorToken(0x6f6f6f));
        assert_eq!(dark.composer_review, ColorToken(0x65b8ff));
        assert_eq!(dark.composer_danger, ColorToken(0xfe8549));
        assert_eq!(dark.composer_orb, ColorToken(0xededed));
        assert_eq!(dark.composer_on_orb, ColorToken(0x101010));
        assert_eq!(dark.composer_stop, ColorToken(0x2b2b2b));
        assert_eq!(dark.running, ColorToken(0xd4d4d4));
        assert_eq!(dark.file_reference, ColorToken(0x515aad));
        assert_eq!(dark.effort, ColorToken(0xef706e));
        assert_eq!(light.background, ColorToken(0xfdfdfd));
        assert_eq!(light.shelf, ColorToken(0xfafafa));
        assert_eq!(light.text, ColorToken(0x27272a));
        assert_eq!(light.line, ColorToken(0xebebed));
        assert_eq!(light.queue_background, ColorToken(0xffffff));
        assert_eq!(light.queue_line, ColorToken(0xeeeeef));
        assert_eq!(light.queue_action, ColorToken(0x96969a));
        assert_eq!(light.composer_placeholder, ColorToken(0xc7c7ca));
        assert_eq!(light.composer_review, ColorToken(0x2d72dc));
        assert_eq!(light.composer_danger, ColorToken(0xef4d05));
        assert_eq!(light.composer_orb, ColorToken(0x1d1d1f));
        assert_eq!(light.composer_on_orb, ColorToken(0xffffff));
        assert_eq!(light.composer_stop, ColorToken(0x1d1d1f));
        assert_eq!(light.running, ColorToken(0x52525b));
        assert_eq!(light.file_reference, ColorToken(0x4a53a8));
        assert_eq!(light.effort, ColorToken(0xc2413d));
    }

    #[test]
    fn syntax_palettes_match_the_web_shiki_themes() {
        let dark = github_highlight_theme(ThemeMode::Dark);
        let light = github_highlight_theme(ThemeMode::Light);
        let color = |theme: &HighlightTheme, capture: &str| {
            theme
                .style(capture)
                .and_then(|style| style.color)
                .expect("capture should have an explicit color")
        };

        assert_eq!(dark.style.editor_foreground, Some(rgb(0xe6edf3).into()));
        assert_eq!(color(&dark, "comment"), rgb(0x8b949e).into());
        assert_eq!(color(&dark, "keyword"), rgb(0xff7b72).into());
        assert_eq!(color(&dark, "string"), rgb(0xa5d6ff).into());
        assert_eq!(color(&dark, "number"), rgb(0x79c0ff).into());
        assert_eq!(color(&dark, "function"), rgb(0xd2a8ff).into());
        assert_eq!(color(&dark, "type"), rgb(0xffa657).into());
        assert_eq!(color(&dark, "tag"), rgb(0x7ee787).into());

        assert_eq!(light.style.editor_foreground, Some(rgb(0x1f2328).into()));
        assert_eq!(color(&light, "comment"), rgb(0x6e7781).into());
        assert_eq!(color(&light, "keyword"), rgb(0xcf222e).into());
        assert_eq!(color(&light, "string"), rgb(0x0a3069).into());
        assert_eq!(color(&light, "number"), rgb(0x0550ae).into());
        assert_eq!(color(&light, "function"), rgb(0x8250df).into());
        assert_eq!(color(&light, "type"), rgb(0x953800).into());
        assert_eq!(color(&light, "tag"), rgb(0x116329).into());
    }

    #[test]
    fn language_specific_shiki_scopes_keep_common_code_semantics() {
        let color = |language: &str, capture: &str| {
            github_highlight_theme_for_language(ThemeMode::Dark, language)
                .style(capture)
                .and_then(|style| style.color)
                .expect("capture should have an explicit color")
        };

        assert_eq!(color("typescript", "property"), rgb(0xe6edf3).into());
        assert_eq!(color("json", "property"), rgb(0x7ee787).into());
        assert_eq!(color("yaml", "property"), rgb(0x7ee787).into());
        assert_eq!(color("css", "property"), rgb(0x79c0ff).into());
        assert_eq!(color("diff", "string"), rgb(0x7ee787).into());
        assert_eq!(color("diff", "keyword"), rgb(0xffa198).into());
        assert_eq!(color("python", "type"), rgb(0x79c0ff).into());
        assert_eq!(color("toml", "type"), rgb(0xe6edf3).into());
        assert_eq!(color("toml", "property"), rgb(0xffa657).into());
    }

    #[test]
    fn backdrops_do_not_recolor_fixed_composer_surfaces() {
        let dark = Theme::new(ThemeMode::Dark, Backdrop::Slate, Accent::Neutral);
        let light = Theme::new(ThemeMode::Light, Backdrop::Plum, Accent::Neutral);

        assert_eq!(dark.shelf, ColorToken(0x222222));
        assert_eq!(dark.queue_background, ColorToken(0x222222));
        assert_eq!(light.shelf, ColorToken(0xfafafa));
        assert_eq!(light.queue_background, ColorToken(0xffffff));
    }

    #[test]
    fn srgb_mix_matches_css_color_mix_channel_weighting() {
        let dark = Theme::dark();
        let light = Theme::light();

        assert_eq!(
            dark.attention.mix_srgb(dark.line_strong, 0.55),
            ColorToken(0x416da3)
        );
        assert_eq!(
            light.attention.mix_srgb(light.line_strong, 0.55),
            ColorToken(0x789ae7)
        );
    }

    #[test]
    fn oklab_mix_matches_css_semantic_color_interpolation() {
        let dark = Theme::dark();
        let light = Theme::light();

        assert_eq!(
            dark.success.mix_oklab(dark.line, 0.45),
            ColorToken(0x476652)
        );
        assert_eq!(dark.error.mix_oklab(dark.line, 0.45), ColorToken(0x77454a));
        assert_eq!(
            light.success.mix_oklab(light.line, 0.45),
            ColorToken(0x94bb9c)
        );
        assert_eq!(
            light.error.mix_oklab(light.line, 0.45),
            ColorToken(0xe0979a)
        );
    }

    #[test]
    fn every_backdrop_and_accent_has_a_distinct_typed_variant() {
        let slate = Theme::new(ThemeMode::Dark, Backdrop::Slate, Accent::Ocean);
        let plum = Theme::new(ThemeMode::Light, Backdrop::Plum, Accent::Lavender);

        assert_eq!(slate.background, ColorToken(0x0e1013));
        assert_eq!(slate.prompt, ColorToken(0x191d24));
        assert_eq!(slate.surface, ColorToken(0x191d24));
        assert_eq!(slate.attention, ColorToken(0x65b8ff));
        assert_eq!(slate.file_reference, ColorToken(0x62abc7));
        assert_eq!(slate.effort, ColorToken(0x74b8cf));
        assert_eq!(plum.background, ColorToken(0xfbf8fc));
        assert_eq!(plum.prompt, ColorToken(0xfdfcfe));
        assert_eq!(plum.surface, ColorToken(0xf3eef4));
        assert_eq!(plum.attention, ColorToken(0x6653aa));
        assert_eq!(plum.file_reference, ColorToken(0x675896));
        assert_eq!(plum.effort, ColorToken(0x81548f));
    }

    #[test]
    fn light_backdrops_keep_the_prompt_lighter_than_the_surface() {
        let expected = [
            (Backdrop::Slate, 0xfbfcfe, 0xeef2f7),
            (Backdrop::Mocha, 0xfefdfb, 0xf4f0eb),
            (Backdrop::Forest, 0xfcfefc, 0xeef4ee),
            (Backdrop::Midnight, 0xfafbfe, 0xebeef7),
            (Backdrop::Plum, 0xfdfcfe, 0xf3eef4),
        ];
        for (backdrop, prompt, surface) in expected {
            let theme = Theme::new(ThemeMode::Light, backdrop, Accent::Neutral);
            assert_eq!(theme.prompt, ColorToken(prompt));
            assert_eq!(theme.surface, ColorToken(surface));
        }
    }
}
