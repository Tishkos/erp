/** `qrcode-terminal` ships no types; the bridge uses one function of it. */
declare module 'qrcode-terminal' {
  const qrcode: {
    generate(text: string, options?: { small?: boolean }, callback?: (output: string) => void): void;
  };
  export default qrcode;
}
