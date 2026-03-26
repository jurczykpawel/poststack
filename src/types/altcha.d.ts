declare namespace JSX {
  interface IntrinsicElements {
    "altcha-widget": React.DetailedHTMLProps<
      React.HTMLAttributes<HTMLElement> & {
        challengeurl?: string;
        hidelogo?: boolean;
        hidefooter?: boolean;
        strings?: string;
      },
      HTMLElement
    >;
  }
}
