# Twig Toolbox diagnostics

Syntax diagnostics come directly from `@twig-toolbox/parser` parse errors and keep the parser's stable error codes:

- `unterminated-comment`
- `unterminated-output`
- `unterminated-block`
- `unterminated-string`
- `unterminated-verbatim`
- `unterminated-interpolation`
- `mismatched-delimiter`
- `unexpected-character`
- `missing-tag-name`
- `missing-end-tag`
- `mismatched-end-tag`
- `unexpected-end-tag`
- `unexpected-token`
- `removed-in-twig-3`
- `missing-expression`
- `missing-property`
- `missing-filter-name`
- `missing-test-name`
- `missing-name`
- `unclosed-parenthesis`
- `unclosed-bracket`
- `unclosed-brace`
- `invalid-assignment-target`

Unknown-name diagnostics are opt-in through `twigToolbox.diagnostics.unknownNames` and use these server-level codes:

- `unknown-tag`
- `unknown-filter`
- `unknown-function`
- `unknown-test`

The default is `off` to preserve zero false positives for Craft and plugin-heavy projects.
