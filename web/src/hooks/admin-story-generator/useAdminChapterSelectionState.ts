import { useState } from "react";

import { AdminBookInfo, AdminChapterSummary } from "../../core/types";

type UseAdminChapterSelectionStateOptions = {
  defaultMinChars: number;
  defaultMaxChars: number;
  defaultSceneCount: number;
  defaultChapterPageSize: number;
  chapterPageSizeOptions: readonly number[];
  chapterPageSizeStorageKey: string;
};

export function useAdminChapterSelectionState(options: UseAdminChapterSelectionStateOptions) {
  const {
    chapterPageSizeOptions,
    chapterPageSizeStorageKey,
    defaultChapterPageSize,
    defaultMaxChars,
    defaultMinChars,
    defaultSceneCount,
  } = options;

  const [books, setBooks] = useState<AdminBookInfo[]>([]);
  const [chapters, setChapters] = useState<AdminChapterSummary[]>([]);
  const [loadingChapters, setLoadingChapters] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [bookId, setBookId] = useState<string>("");
  const [keyword, setKeyword] = useState("");
  const [minCharsInput, setMinCharsInput] = useState(String(defaultMinChars));
  const [maxCharsInput, setMaxCharsInput] = useState(String(defaultMaxChars));
  const [includeUsed, setIncludeUsed] = useState(true);

  const [selectedChapterId, setSelectedChapterId] = useState<number | null>(null);
  const [targetDate, setTargetDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [sceneCountInput, setSceneCountInput] = useState(String(defaultSceneCount));
  const [chapterPage, setChapterPage] = useState(1);
  const [chapterPageSize, setChapterPageSize] = useState<number>(() => {
    if (typeof window === "undefined") {
      return defaultChapterPageSize;
    }

    const savedValue = Number(window.localStorage.getItem(chapterPageSizeStorageKey));
    return chapterPageSizeOptions.includes(savedValue)
      ? savedValue
      : defaultChapterPageSize;
  });
  const [chapterTotal, setChapterTotal] = useState(0);

  return {
    bookId,
    books,
    chapterPage,
    chapterPageSize,
    chapterTotal,
    chapters,
    includeUsed,
    keyword,
    loadingChapters,
    maxCharsInput,
    minCharsInput,
    sceneCountInput,
    selectedChapterId,
    setBookId,
    setBooks,
    setChapterPage,
    setChapterPageSize,
    setChapterTotal,
    setChapters,
    setIncludeUsed,
    setKeyword,
    setLoadingChapters,
    setMaxCharsInput,
    setMinCharsInput,
    setSceneCountInput,
    setSelectedChapterId,
    setSubmitting,
    setTargetDate,
    submitting,
    targetDate,
  };
}
