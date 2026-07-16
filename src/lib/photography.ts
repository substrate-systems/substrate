export type PhotographyImage = {
  id: string;
  src: string;
  width: number;
  height: number;
  alt: string;
  caption?: string;
  treatment: "colour" | "black-and-white";
  pairWithNext?: boolean;
};

export type PhotographySeries = {
  slug: string;
  title: string;
  year: number;
  date: string;
  location: string;
  introduction: string;
  cover: string;
  images: readonly PhotographyImage[];
};

export const icelandAuroraSeries: PhotographySeries = {
  slug: "iceland-aurora",
  title: "Iceland Aurora",
  year: 2026,
  date: "March 2026",
  location: "Iceland",
  introduction:
    "A movement from landscape into light, where the aurora becomes texture, gesture, and form.",
  cover: "/photography/iceland-aurora/11-iceland-aurora-02130-4.jpg",
  images: [
    {
      id: "iceland-aurora-02111",
      src: "/photography/iceland-aurora/01-iceland-aurora-02111.jpg",
      width: 3000,
      height: 2000,
      alt: "Green aurora sweeping above a snowy horizon and a line of bare trees in Iceland.",
      treatment: "colour",
    },
    {
      id: "iceland-aurora-02123",
      src: "/photography/iceland-aurora/02-iceland-aurora-02123.jpg",
      width: 3000,
      height: 2000,
      alt: "Emerald aurora curling through clouds against a deep blue night sky.",
      treatment: "colour",
    },
    {
      id: "iceland-aurora-02125",
      src: "/photography/iceland-aurora/03-iceland-aurora-02125.jpg",
      width: 3000,
      height: 2000,
      alt: "Green aurora unfurling in a feathered arc with lines of motion radiating through the sky.",
      treatment: "colour",
    },
    {
      id: "iceland-aurora-02127",
      src: "/photography/iceland-aurora/04-iceland-aurora-02127.jpg",
      width: 3000,
      height: 2000,
      alt: "A flowing green aurora folding diagonally across a dark blue opening in the clouds.",
      treatment: "colour",
    },
    {
      id: "iceland-aurora-02128-3",
      src: "/photography/iceland-aurora/05-iceland-aurora-02128-3.jpg",
      width: 3000,
      height: 2000,
      alt: "Aurora light rushing outward in green and cyan streaks around a dark centre.",
      treatment: "colour",
    },
    {
      id: "iceland-aurora-02131",
      src: "/photography/iceland-aurora/06-iceland-aurora-02131.jpg",
      width: 3000,
      height: 2000,
      alt: "Abstract green and blue aurora radiating from a dark central fold.",
      treatment: "colour",
      pairWithNext: true,
    },
    {
      id: "iceland-aurora-02131-3",
      src: "/photography/iceland-aurora/07-iceland-aurora-02131-3.jpg",
      width: 3000,
      height: 2000,
      alt: "Black-and-white aurora bursting outward in soft, luminous streaks.",
      treatment: "black-and-white",
    },
    {
      id: "iceland-aurora-02124-3",
      src: "/photography/iceland-aurora/08-iceland-aurora-02124-3.jpg",
      width: 3000,
      height: 2000,
      alt: "Monochrome clouds and aurora drawn into a turbulent, painterly swirl.",
      treatment: "black-and-white",
    },
    {
      id: "iceland-aurora-02126-3",
      src: "/photography/iceland-aurora/09-iceland-aurora-02126-3.jpg",
      width: 3000,
      height: 2000,
      alt: "Black-and-white aurora curling like a wave beneath a field of stars.",
      treatment: "black-and-white",
    },
    {
      id: "iceland-aurora-02129-3",
      src: "/photography/iceland-aurora/10-iceland-aurora-02129-3.jpg",
      width: 3000,
      height: 2000,
      alt: "Luminous black-and-white aurora sweeping through clouds in a broad spiral.",
      treatment: "black-and-white",
    },
    {
      id: "iceland-aurora-02130-4",
      src: "/photography/iceland-aurora/11-iceland-aurora-02130-4.jpg",
      width: 3000,
      height: 2000,
      alt: "Dramatic monochrome aurora exploding into bright radial bands across the frame.",
      treatment: "black-and-white",
    },
    {
      id: "iceland-aurora-02132-2",
      src: "/photography/iceland-aurora/12-iceland-aurora-02132-2.jpg",
      width: 3000,
      height: 2000,
      alt: "Soft black-and-white rays streaming from a shadowed centre like an afterimage.",
      treatment: "black-and-white",
    },
    {
      id: "iceland-aurora-02136",
      src: "/photography/iceland-aurora/13-iceland-aurora-02136.jpg",
      width: 3000,
      height: 2000,
      alt: "Green aurora and a bright moon hanging above a snow-covered Icelandic landscape.",
      treatment: "colour",
    },
  ],
};
