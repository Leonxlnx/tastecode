export const PAGE_LAYOUT_GUIDANCE = `Layout vocabulary is a decision aid, not a template library. Select and adapt a composition from the actual message hierarchy, brand character, asset geometry, page mode, and viewport. Do not rotate through patterns for variety. The same geometry can feel entirely different through type scale, font roles, spacing, crop, color, surface, radius, button treatment, and motion; derive those from the approved brand system.

Hero composition:
- Keep orientation immediate: a concise heading, only the support needed to understand it, and a clear primary action. Use one secondary action only when it represents a genuinely different next step.
- centered_statement: centered heading, short supporting line, then actions.
- corner_counterweight: heading and support/actions in one lower corner; concise proof, metadata, or a small information cluster counterbalances the opposite corner.
- art_led_minimal: brand or short heading, one very short line, and one action; visual direction carries most of the atmosphere.
- top_statement_bottom_support: heading near the upper center or upper edge; supporting copy and action form a lower anchor.
- split_copy_media: copy and actions on one side with a relevant image, illustration, product view, or object on the other. Either side is valid when reading order, crop, and brand direction justify it.
- top_left_diagonal_support: heading at the upper left; supporting copy, action, or factual detail resolves the lower left and lower right.
- Hybridize only when hierarchy stays obvious. A hero still needs one dominant reading path, not a collage of all patterns.

Hero media relationships:
- full_bleed_atmosphere: image or artwork fills the hero. Protect copy contrast and choose color from verified brand roles or from a natural, context-fitting atmosphere.
- side_subject: a clean side image or graphic supports a split composition.
- lower_stage: image, illustration, or SVG occupies roughly the lower half or extends below the fold while the opening message remains visible.
- lower_product_reveal: a product, dashboard, interface, or object preview rises from the lower edge without becoming a generic SaaS mockup.
- surrounding_constellation: a centered message is framed by a small number of meaningful assets with controlled overlap and depth.
- Background imagery must carry a concept or useful mood. Do not add decoration merely to fill space.

Navigation composition:
- Treat navigation as a distinct composition that is visually related to the hero. The primary logo may sit left or center and always returns to the main page.
- Keep account actions, sign-in, locale choice, or the primary global action at the right when they exist. A centered logo may use navigation on the left or a balanced split around it, but never crowd the right-side actions.
- direct: visible destination links for a shallow information architecture.
- disclosure: a labeled destination opens a real mega-menu only when deeper pages need it. The panel may use a text-and-icon list beside one visual, horizontal illustrated choices, or a restrained bento arrangement. Every item remains a functioning destination.
- edge_to_edge: the navigation surface spans the viewport and any disclosure continues from that full-width shell.
- floating_capsule: a contained floating bar may use a pill or another brand-derived radius; do not default every site to a capsule.
- transparent_to_surface: navigation begins integrated with the hero and gains a legible surface once scrolling starts.
- minimal_menu: logo at the left with concise context and a menu trigger at the right; the trigger opens a focused navigation card.
- Record layout and scroll/disclosure behavior in navigationDesign. Record the actual destinations in navigation.

Responsive and motion behavior:
- Preserve heading, support, action, and proof order on compact screens. Recompose rather than squeeze a desktop split or mega-menu.
- Mega-menus must work by keyboard and pointer, keep focus stable, and collapse into a deliberate compact navigation flow.
- Derive timing, easing, depth, and surface transitions from motionDirection. Animate spatial relationships or state changes, not generic fade-up sequences.
- A transparent_to_surface navigation may interpolate background, border, and shadow as scroll crosses a meaningful threshold. Disclosure panels open from a stable origin with fast, reversible motion and a reduced-motion path.
- Hero media may remain still. Add parallax, drifting assets, or staged entrances only when the approved visual concept requires them and readability remains stable.`
