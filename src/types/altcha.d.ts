declare namespace JSX {
  interface IntrinsicElements {
    "altcha-widget": React.DetailedHTMLProps<
      React.HTMLAttributes<HTMLElement> & {
        challenge?: string;
        display?: "standard" | "bar" | "floating" | "overlay" | "invisible";
        strings?: string;
      },
      HTMLElement
    >;
  }
}
