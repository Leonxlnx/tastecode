# Photographs

A place (café, bakery, guesthouse, shop, studio) is its photographs: two or three on every screen, the
client's own. Software leads with its real interface; a photograph there is a real person or the real
product. A game leads with its own art (key art, in-engine shots, the trailer's poster); with no art files its key art is a product render of its hero object or world (`sections.md`, Gaming), never a photograph or an effect in its place. A photograph never stands where an effect, a drawing or an empty box would.

**In TasteCode there is no picture library.** This skill ships without the upstream photo library and
without sample pictures, and `scripts/photos.mjs` is switched off. Nothing is dealt, fetched or
filled from stock. The pictures come from the brief and the user's own files. In a Design mode run,
they can also come from TasteCode's Asset phase, which records where each file came from.

## Where pictures come from (PH-01, PH-05)

1. **The client's own**, shot for the page or on a phone, each file named in the brief or supplied by the user. Every
   `<img>` carries `data-source` (`client`, `commissioned`, `phone`, `supplier`, `illustration`) and `data-subject`.
2. **Nothing yet**: a product's own render (`effects-objects.md`, Product renders), the real UI, or type. Where a section
   needs a photograph the client has not supplied, its frame is a named slot for that file (`sections-library.md`,
   client-slots): a frame that reads finished now, named in a comment for the client's file, listed in the report.
   Never a near fit, never mood in place of the subject, never a stock picture as a stand-in.

With no client photographs, say so plainly in the report: strong pages run on a half-day shoot with a local
photographer, then a one-morning phone shoot, then products on one backdrop. The shot list: shopfront straight on,
the room from the door, the counter or bench, three products on one surface, hands at work, one detail, each room
of a guesthouse; 1x lens, window light, no flash, no filter, landscape and portrait. **The count decides:** a place
with fewer than eight pictures of its own is the short page (PH-07: 2,700 px at most at 1440; `sections.md`
section 4, The short page). No drawn box, grid or effect takes the place of a photograph.

## A product without photographs (PH-04)

A maker of a physical thing (a bike, a chair, a lamp, a stroller, a device) with no photographs of its own gets **no
stock photographs**: no forest for "the ride", no groceries for "what it carries", no other trade to fill the page.
**The product is still shown, never hidden:** it is rendered with the objects kit's product-render helper
(`assets/objects/product-render`, `effects-objects.md` Product renders), one crafted studio render composed from a
JSON spec of its own parts, sizes and materials, and the page is the full product page (`sections.md`, Product: hero,
the product, what it carries, how it is used, specs as rows, a live order card), never the short page. The render is
the product's picture on a flat ground, not an effect. Never a drawn SVG, mood stock, another maker's product or an
object of another kind (a wheel is not a bicycle). A render or CAD view the brief supplies comes first; renders it
names but does not supply count as missing. The report lists the shots to take: the product on one plain backdrop,
three angles, a detail of each part the page names, the product in use.

## Place them

- A place page uses 4:5, 4:3 and 1:1 only; other kinds add 3:2. One ratio per row, equal sizes in a row, one dominant
  picture per screen or a row of three or four. Frames sit on the container lines (x 120-1320 on a place, 80-1360
  elsewhere; 342 wide at 390): full-bleed only as a hero or section layer. Left and right edges stay the same down the page.
- One visual world: one light, one grade, one register across the set. Never studio black with daylight, HDR beside a
  snapshot, two photographers' grades. Black and white is one deliberate frame. Never the same frame twice on a page
  (a smaller file, a crop or a mirror of a frame is the same frame) and never three near-identical ones. On a product
  page the product whole in three sections at most, its use, its parts and the people with it in the rest
  (`sections.md`, Product, rule 2).
- **Hero**: plain full colour, the client's own (Recipe 3 on a place: a full-bleed top photograph, 480 px tall, with
  nothing on it and the words below it); a software or product hero ends inside the screen. **Rooms**: one detail per
  room beside its facts. **Menu or goods**: the list in plain text beside the offer's composition, never one
  photograph per line, never a tab. **Photo bands**: product one or two; a place one, its `bleed` composition, never
  next to the hero. **Compositions** on a place (`bleed`, `pair`, `trio`, `strip`, `tall-small`): `sections.md`
  section 4, Designed variety; never two sections built round one picture.
- Text on a photograph: never on a place; elsewhere the hero and one closing band only, on a calm part that is empty and
  dark (or light) at the desktop and the phone crop, or in a solid box, or off the photograph. No scrim, gradient, fade
  or blur. At 768 a 3:2 lead is cropped to its middle: when that puts the words over the subject, they go under it as
  on a phone.
- Every full-bleed photograph that carries words has a crop for 390 (`<picture>`, subject inside the middle 342px).
- Cut-outs only of the client's own subject (transparent WebP, `data-subject="product"`), on the page ground or one
  backdrop, no drop or fake shadow, never stock, never people or buildings. Supplier or maker images only inside a
  product grid, only what is sold, never the hero. Illustration only when the client already owns it, still.

## Show them

- Ship each picture at the widths it is shown: a 1200 for a row picture, the hero up to 1920 (and its 2x where the
  client's file has the pixels), WebP where possible; a hero within 400 KB, any other picture within 250 KB, the page's
  pictures together under 2,400 KiB at 1440, the figure `perf.mjs` FAILs above.
- A hero: `sizes="100vw"` (never a vh term), `fetchpriority="high"`, eager, and a crop for the phone in a `<picture>`
  `<source media="(max-width: 639px)">` with the subject inside the middle 342 px. Every other picture is
  `loading="lazy"` and `decoding="async"`, `width` and `height` set, `sizes` set to the shown width.
- A photograph in a nav menu or a tab panel drops `loading="lazy"`; carousels and sideways rows are never built.
  `object-position` is the subject's place, so a phone's square crop keeps the cup or the hand.
- **A photograph is visible from the first paint**: never in an element that starts at opacity 0, clipped or moved for a
  scroll reveal, never under a print, dissolve or mask that develops on load, never a video in its place. Shoot 1440,
  1024, 768 and 390 and look for any empty frame (a grey, blank or half-loaded frame counts): an empty ground is a fault.
- **No print, grade or effect on any photograph**: no halftone, dither, duotone, engraving, grain, glitch, filter or
  blend mode, and no canvas over half of it. Mixed light gets a crop and one ratio system, not an effect.
- **Hover** (PH-25, one wording with `motion.md`): a photograph in a card that links zooms to 1.03 (1.02 to 1.03 is the
  range) over 600 ms inside its own mask (the frame is `overflow: hidden`, never grows or moves); a photograph outside a
  linked card does nothing. No tilt, no rotation, no Ken Burns at rest; on a place the photograph never changes
  opacity. The linked card also lifts 2px (`motion.md`).
- Place photographs are square-cornered, with no border, shadow, overlay or frame; product and service use one radius
  for every photograph; software windows one radius of 12 to 20px.

## Credits and words (PH-38, CO-22)

No caption, label or description sits under or on any picture (house rule), and no credit, "sample" or example note: a
sold item's name and price sit inside its card's padding (`copy.md`), never as a line under a bare picture. The place's
name goes in the alt text. A picture whose licence asks for a credit gets it in **one footer line** in the legal row
that links or opens the credits list, never a link per photograph in the footer; the list gives each author, licence
and source page, `adapted` after any picture cropped or graded beyond its frame. Every word on a page is live text,
never baked into an image.

## Never

- A picture from a stock collection, an image library or a template as content, a stand-in or a placeholder.
- Another business's identifiable room, counter, sign, cup, bag or product shown as the client's; a machine with its
  maker's name. A face as staff, guest or customer that is not the client's own. Another place's coast, street or
  landmark as the client's.
- The trade's stock shot: latte art from above, beans filling the frame, the croissant-and-cappuccino still life, a
  made bed, flour thrown on black, a whole figure.
- Mood (a curtain, plant shadows, a sky, grass, a forest, fog, an aurora, a waterfall), a recognisable viewpoint,
  composites, Street View, a sight far from the place, a gradient, grain, pattern or shader standing in for a
  photograph.
