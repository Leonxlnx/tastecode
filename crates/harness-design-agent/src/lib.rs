mod assets;
mod brand;
mod brief;
mod common;
mod page;
mod phases;
mod preview;
mod review;
mod run;
mod workflow;

pub use assets::{
    AssetKind, AssetManifest, AssetSource, AssetSourceKind, AssetStatus, DesignAsset,
    parse_asset_manifest, read_asset_manifest, write_asset_manifest,
};
pub use brand::{BrandSystem, parse_brand_system, read_brand_system, write_brand_system};
pub use brief::{
    DesignBrief, ExplicitBriefAnswer, parse_design_brief, read_design_brief, write_design_brief,
};
pub use page::{
    PageBlueprint, PageLink, parse_page_blueprint, read_page_blueprint, write_page_blueprint,
};
pub use phases::{
    BuildPhaseOutput, design_asset_prompt, design_brand_prompt, design_build_prompt,
    design_page_prompt, parse_asset_phase_output, parse_brand_phase_output,
    parse_build_phase_output, parse_page_phase_output,
};
pub use preview::{
    PreviewPlan, PreviewViewport, design_preview_prompt, parse_preview_phase_output,
    parse_preview_plan,
};
pub use review::{
    RepairPhaseOutput, ReviewFinding, ReviewScreenshot, ReviewSeverity, ReviewVerdict,
    VisualReview, design_repair_prompt, design_review_prompt, parse_repair_phase_output,
    parse_review_phase_output, read_visual_review, write_visual_review,
};
pub use run::{
    DesignPhase, DesignRunError, DesignRunPhase, DesignRunState, DesignRunStatus,
    create_design_run_state, next_design_phase, parse_design_run_state,
};
pub use workflow::{
    BriefingOption, BriefingOutput, BriefingQuestion, DESIGN_BRIEF_ATTACHMENT,
    FINAL_BRIEFING_QUESTION_ID, design_briefing_continuation, design_briefing_prompt,
    design_phase_correction_prompt, final_briefing_question, parse_briefing_output,
};

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct DesignError(String);

impl DesignError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

pub type Result<T> = std::result::Result<T, DesignError>;
