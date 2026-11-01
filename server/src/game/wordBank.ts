export interface WordEntry {
  category: string;
  word: string;
  impostorClue: string;
}

export const wordBank: WordEntry[] = [
  {
    category: "Food",
    word: "Pizza",
    impostorClue: "Italian food",
  },
  {
    category: "Food",
    word: "Burger",
    impostorClue: "Fast food",
  },
  {
    category: "Technology",
    word: "Laptop",
    impostorClue: "Electronic device",
  },
  {
    category: "Technology",
    word: "Smartphone",
    impostorClue: "Communication device",
  },
  {
    category: "Animals",
    word: "Elephant",
    impostorClue: "Large wild animal",
  },
  {
    category: "Animals",
    word: "Penguin",
    impostorClue: "Flightless bird",
  },
  {
    category: "Places",
    word: "Paris",
    impostorClue: "Famous European destination",
  },
  {
    category: "Places",
    word: "Beach",
    impostorClue: "Popular holiday destination",
  },
  {
    category: "Entertainment",
    word: "Titanic",
    impostorClue: "Famous movie",
  },
  {
    category: "Science",
    word: "Gravity",
    impostorClue: "Natural phenomenon",
  },
];

export function getRandomWord(): WordEntry {
  const index = Math.floor(Math.random() * wordBank.length);
  return wordBank[index];
}
