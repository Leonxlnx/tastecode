// The rich Markdown renderer's stylesheets, apart from its code so the app can
// load them ahead of it. KaTeX's declares twenty @font-face rules, and a
// stylesheet that adds font faces makes the browser lay the whole document out
// again: arriving with the renderer during a chat's first open, it repeated
// the transcript's whole layout before the chat's first paint.
import 'streamdown/styles.css'
import 'katex/dist/katex.min.css'
