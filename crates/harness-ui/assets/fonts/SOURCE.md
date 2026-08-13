# Geist font sources

The bundled Geist and Geist Mono faces come from Google Fonts commit
`2d85e20401920891efb7cd6272d6339685df2820`:

- `ofl/geist/Geist[wght].ttf`
- `ofl/geistmono/GeistMono[wght].ttf`

The static 400, 450, 500, 520, 530, 540, 550, 560, 570, 580, 600, 680, and
700 faces were instantiated with fonttools 4.63.0. The intermediate faces
preserve the exact CSS weights used by the original renderer while remaining
selectable through GPUI's platform font matching.
