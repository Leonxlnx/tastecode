export const PAGE_LAYOUT_GUIDANCE = `Use the following beta layout cases as the source material for Hero, Navigation, About, and Feature decisions. Select the case that best fits the content and brand, or lightly combine compatible cases. Keep the described composition recognizable instead of replacing it with an unrelated default layout.

The layout case is only part of the result. Font choice and scale, brand colors, spacing, button placement and treatment, corner radii, navigation placement, media crop, and motion create much of the final feeling. Resolve all of them from the approved brand direction. Motion must fit the selected style and composition rather than being added as a generic effect.

Hero text-layout cases:
1. Place a short, clear headline in the center. Add one smaller supporting sentence beneath it, followed by one or two CTA buttons.
2. Place the headline at the bottom left or bottom right. Add a short supporting line or description and the CTA buttons below it. Use the opposite bottom side for a small amount of additional information, either as clean text or in fitting cards.
3. Create an ultra-minimal centered hero. It may show only the brand name, one extremely short descriptive line, and one button. Let the visual design carry most of the impact.
4. Place one clear headline near the top center. Put the supporting description elsewhere in the composition, for example at the bottom left, and place the CTA where it best supports that hierarchy.
5. Use the familiar split: headline, supporting text, and CTA buttons on the left; a relevant image or visual on the right. This is common, so use it only when it genuinely fits.
6. Mirror the familiar split: image or visual on the left; headline, supporting text, and CTA buttons on the right.
7. Place the headline at the top left. Divide the supporting description, useful information, and CTA between the bottom left and bottom right with a clear reading order.

A Hero may lightly mix these text placements when the hierarchy remains clear. It still needs an immediately understandable headline, enough context to understand the offer, and a clear CTA. Do not make the composition complicated merely to appear different.

Hero image, graphic, and product-visual cases:
1. Use a full-screen background image. It may be minimal, visually intense, or otherwise appropriate. Brand color is especially important; when the site has no strong brand color, choose a natural color treatment that fits the intended mood.
2. Place one clean image on the left or right, according to the chosen text layout.
3. Place an image in the lower part of the Hero. It may occupy about half of the screen or extend farther, but it should already be visible in the initial Hero view.
4. Use a graphic, SVG, or more complex designed visual in the lower part of the Hero in the same way as the lower image case.
5. When the text is centered, arrange fitting images or other visual assets around the central message.
6. Place the text near the top center and show a wide dashboard, product preview, interface, or other relevant product visual beneath it. The preview may be broad without having to span the entire viewport.
7. Use a creative image or designed visual as the Hero background.

Navigation foundations:
- Treat Navigation as part of the Hero composition even though its layout is decided separately.
- Use either an icon mark or a full logo. Place it on the left or in the center. The logo always returns to the homepage or main landing page.
- Navigation destinations may appear as text links or button-like controls and must lead to the real page or section.
- Sign in, log in, sign up, and the main global CTA normally belong at the top right when they exist.
- A language selector may be included when the product needs one.
- With a centered logo, either place the main destinations on the left or distribute a small number around the logo. Keep enough space for account and CTA actions at the far right.

Navigation layout cases:
1. Use a normal, clean navigation bar with clickable page or section destinations and the logo linking home.
2. For a deeper site with destinations such as Enterprise, Solutions, or Pricing, let relevant items show a down arrow and open a larger card on hover or deliberate activation. The card may use one of these exact arrangements:
   a. Place a list of destinations with icons and subheadings on the left and a fitting image, designed visual, or graphic on the right. Swap the sides when the composition benefits. When there is more information, both sides may contain destination groups.
   b. Arrange destinations horizontally. Give each one an image, a subheading, and one very short explanatory sentence.
   c. Arrange the destinations as a clean bento-style card when that structure fits the amount and type of information.
3. Use a full-width navigation bar that runs from the left edge to the right edge. When it contains hover or disclosure content, let that panel also expand across the full width beneath it.
4. Use a long, modern floating pill or contained bar. Its corner radius may vary with the brand; it does not always need to be fully pill-shaped.
5. Begin with only the Hero content visible behind the navigation. As the user scrolls, smoothly introduce the navigation background or surface.
6. Use only the logo at the top left and a small amount of information or a menu control at the top right. Opening the control reveals a small, clean card with the relevant destinations or information.

All navigation dropdowns, cards, links, language controls, and buttons must actually work. Record the chosen layout and its disclosure or scroll behavior in navigationDesign, and record the real destinations in navigation. On smaller screens, preserve every necessary destination and action in a deliberate compact arrangement rather than squeezing the desktop layout. Use motion that matches the selected visual style and makes opening, closing, scrolling, and hierarchy feel smooth.

About section scope:
- An About section may describe the company, the people who work there, or both.
- Include it only when the page needs it. These are available layout cases, not sections that every page must use.

About layout cases:
1. Use a clean, very short, non-generic heading at the top. Arrange portraits of the people in an orderly grid, such as 2 by 5 or 4 by 3. Place an information card at the bottom inside each image with the person's name, role, and optionally one short description. The card may be inset from the image edges or extend cleanly across the full image width. Its corner radius may be rounded, square, or otherwise derived from the design.
2. Place a "Who we are" heading at the top left. It may be large or small according to the style. Optionally place one sentence at the top right. Show one clean team image beneath it with a caption such as "The team," then optionally add one or two more images with their own descriptions below.
3. Place a large heading at the top, aligned left, centered, or elsewhere according to the design. Build an open asymmetric image-and-text grid beneath it: for example, one large meaningful team image on the left with text below or near it, then a second image on the right shifted farther down with its description beside or beneath it. Scale the grid cells freely. A cell may contain an image, text, a clean brand asset, or a logo.
4. For a smaller team, place the heading first, then the names above the corresponding images in a clean arrangement. For a larger team, the people may move from left to right through a smooth GSAP scroll treatment.
5. Place an image of the team, workplace, or building on the left or right and put the company description on the opposite side.
6. Place one image or a group of images in the center, with additional images arranged on the left and right.
7. Create a more experimental checkerboard composition. Place portraits inside alternating square cells, reveal name cards on hover, leave selected cells empty, and use the opposite side for a short paragraph of company or team text.

Text-led About cases:
1. Use a heading with a block of company or team text. The text may reveal or fade in as the user scrolls, including with GSAP when that motion fits. Use clean typography; the type may be large or smaller according to the style. Place a small number of images beneath it.
2. Use only a heading and a larger amount of text, displayed creatively. The copy may use normal paragraphs or another fitting editorial arrangement.

About cards remain an open design surface: use any fitting card composition for people, facts, images, or company information rather than forcing one fixed card template. These cases may be refined later with fitting OriginKit components, but OriginKit must not replace the selected layout idea.

Feature section scope:
- Treat Features as one of the most open section types. These layouts may also fit a How It Works, Showcase, product explanation, or another later section when the content has the same structural needs.
- Use only the number of features the page actually needs. A layout may contain two, three, four, or five items; avoid placing so many in one row that each item loses clarity.

Feature heading cases:
1. Align the heading in the center, left, or even right according to the design and the page's established alignment logic.
2. Center the heading with one short centered description beneath it.
3. Place the heading on the left and the description on the right.
4. Reverse that relationship: description on the left and heading on the right.
5. Place the heading and description together on the left in a clean stack.
6. Use only the heading when no description is necessary.

Feature grid and card cases:
1. Use one horizontal row of three cards. Place an SVG, animation, or image in the upper part of each card and its feature description beneath it.
2. Use three larger rows stacked from top to bottom when each feature needs more content. Place text and description on one side and a visualization on the other. Alternate the sides when appropriate. The visualizations may become progressively wider from one row to the next, creating a stair-step composition. This may also use two, four, or five rows when the content requires it.
3. Use a bento or another grid arrangement. Bento geometry may vary widely: four cards above and three below; one long and one short card above with the proportions reversed below; two-by-two or repeated pairs; or another arrangement that fits the content.
4. Inside a grid or bento card, include a feature heading and, when needed, one explanatory sentence. The sentence may highlight important keywords. Add a fitting visualization: an image, a creative product visual, a SaaS or dashboard mockup, or another relevant designed representation.
5. Feature cards may use colored surfaces, images, or background gradients. Use brand colors deliberately. A later gradient generator may provide fitting card backgrounds, but the gradient must serve the selected feature design.
6. A feature visualization does not need to be an image. It may be a designed SVG or another graphic that responds on hover or animates in a fitting way.

Timed and changing Feature case:
- Present roughly two to five features with a timed progress line. One feature begins active while its line advances; when the interval completes, activate the next feature and replace or transform the visualization.
- The text labels may sit together in one horizontal line and loop through their active states, or each feature may have its own individually animated presentation.
- Place the visualization wherever the chosen composition needs it: left, right, above, or below. GSAP may drive the transition when appropriate.

Large and spatial Feature cases:
1. Use a background image with large feature cards. Let the cards move from left to right through GSAP, horizontal scroll, or direct dragging when that interaction fits. Each large card contains a heading and the extra explanatory text it needs.
2. Give roughly two thirds of the screen to a group of images or visualizations on the left and use the right side to explain them continuously. Mirror the layout when the design works better in the opposite direction.
3. Create a more immersive feature section. Place the text in the center, left, or right according to the composition. As the user scrolls, move images, assets, or visualizations through the scene: they may rise from bottom to top, new elements may enter or fall into the viewport, or the elements may move in a controlled swirl. Use GSAP when appropriate. A later OriginKit component may help implement the effect, but it must preserve this selected layout and movement idea.

Feature cards and visualizations remain an open design surface. Their font scale, spacing, radius, surface, image treatment, brand color, hover behavior, and motion must follow the approved style rather than one universal card design.`
