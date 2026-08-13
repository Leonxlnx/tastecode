export const PAGE_LAYOUT_GUIDANCE = `Use the following beta layout cases as the source material for Hero and Navigation decisions. Select the case that best fits the content and brand, or lightly combine compatible cases. Keep the described composition recognizable instead of replacing it with an unrelated default layout.

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

All navigation dropdowns, cards, links, language controls, and buttons must actually work. Record the chosen layout and its disclosure or scroll behavior in navigationDesign, and record the real destinations in navigation. On smaller screens, preserve every necessary destination and action in a deliberate compact arrangement rather than squeezing the desktop layout. Use motion that matches the selected visual style and makes opening, closing, scrolling, and hierarchy feel smooth.`
