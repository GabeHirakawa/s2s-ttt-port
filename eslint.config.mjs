import s2script from "@s2script/eslint-plugin";

// The SAME pinned rules `s2s build` enforces — the editor's ESLint extension picks this up,
// so a violation is a red squiggle before you ever build (green editor => green build).
export default s2script.configs.recommended({ tsconfigRootDir: import.meta.dirname });
