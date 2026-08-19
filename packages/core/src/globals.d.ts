/** Vite's `?raw` suffix, so `taxonomy-source.browser.ts` typechecks under the workspace tsc. */
declare module '*.yaml?raw' {
  const contents: string;
  export default contents;
}
