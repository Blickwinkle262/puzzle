"""Source parsers for TXT/EPUB books."""

from __future__ import annotations

import html
import re
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path
from typing import Any


@dataclass
class ParsedChapter:
    chapter_index: int
    chapter_title: str
    chapter_text: str
    char_count: int
    word_count: int
    checksum: str
    meta: dict[str, Any]


@dataclass
class ParsedBook:
    title: str
    author: str
    source_format: str
    metadata: dict[str, Any]
    chapters: list[ParsedChapter]


_HEADING_PATTERNS = (
    re.compile(r"^\s*【([^】]{1,120})】\s*$"),
    re.compile(r"^\s*(第[0-9一二三四五六七八九十百千零〇两]+[章节回卷部篇].*)\s*$"),
)
_SKIP_TITLES = {"目录", "概览", "封面", "版权", "扉页"}
_VOLUME_TITLE_PATTERN = re.compile(r"^卷[·\.、\s-]*[0-9一二三四五六七八九十百千零〇两]+$")
_VOLUME_MARKER_PATTERN = re.compile(r"【?卷[·\.、\s-]*[0-9一二三四五六七八九十百千零〇两]+】?")
_SHORT_CJK_TOKEN_PATTERN = re.compile(r"[\u4e00-\u9fff]{2,8}(?=\s|$)")
_PUNCT_PATTERN = re.compile(r"[，。！？；：、“”‘’（）《》【】—…,.!?;:]")
_PLAIN_HEADING_PATTERN = re.compile(r"^[\u4e00-\u9fffA-Za-z0-9·《》〈〉「」『』“”‘’（）()\-—·\s]{2,40}$")
_TOC_FILE_NAME_MARKERS = ("toc", "contents", "nav", "mulu", "index")


class _HtmlTextExtractor(HTMLParser):
    """Very small HTML-to-text extractor to avoid extra dependencies."""

    _BLOCK_TAGS = {
        "p",
        "div",
        "li",
        "ul",
        "ol",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "section",
        "article",
        "br",
        "tr",
        "table",
    }

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() in self._BLOCK_TAGS:
            self._parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() in self._BLOCK_TAGS:
            self._parts.append("\n")

    def handle_data(self, data: str) -> None:
        self._parts.append(data)

    def text(self) -> str:
        return "".join(self._parts)


def detect_format(source_path: Path, forced: str = "auto") -> str:
    if forced in {"txt", "epub"}:
        return forced
    suffix = source_path.suffix.lower()
    if suffix == ".epub":
        return "epub"
    return "txt"


def _normalize_text(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = [line.strip() for line in text.split("\n")]

    compact: list[str] = []
    blank = False
    for line in lines:
        if not line:
            if not blank:
                compact.append("")
                blank = True
            continue
        compact.append(line)
        blank = False

    return "\n".join(compact).strip()


def _extract_plain_heading(line: str, *, prev_line: str | None = None, next_line: str | None = None) -> str | None:
    title = str(line or "").strip()
    if not title:
        return None
    if title in _SKIP_TITLES:
        return None
    if _VOLUME_TITLE_PATTERN.match(title):
        return None
    if not _PLAIN_HEADING_PATTERN.match(title):
        return None
    if _PUNCT_PATTERN.search(title):
        return None

    cjk_count = len(re.findall(r"[\u4e00-\u9fff]", title))
    if cjk_count < 2:
        return None

    prev_normalized = prev_line.strip() if isinstance(prev_line, str) else None
    next_normalized = next_line.strip() if isinstance(next_line, str) else None
    has_prev_blank = prev_normalized == ""
    has_next_blank = next_normalized == ""

    if not (has_prev_blank or has_next_blank):
        return None

    return title


def _extract_title_from_heading(line: str, *, prev_line: str | None = None, next_line: str | None = None) -> str | None:
    for pattern in _HEADING_PATTERNS:
        match = pattern.match(line)
        if not match:
            continue
        title = match.group(1).strip()
        if title in _SKIP_TITLES:
            return None
        if _VOLUME_TITLE_PATTERN.match(title):
            return None
        return title

    return _extract_plain_heading(line, prev_line=prev_line, next_line=next_line)


def _word_count(text: str) -> int:
    tokens = [token for token in re.split(r"\s+", text) if token]
    return len(tokens)


def _looks_like_toc_segment(*, chapter_title: str, body: str) -> bool:
    """Heuristic: detect table-of-contents blocks that slipped into chapter parsing."""

    head = body[:2500]
    if not head:
        return False

    volume_hits = len(_VOLUME_MARKER_PATTERN.findall(head))
    if "附录" in head and "概览" in head and volume_hits >= 1:
        return True

    if volume_hits < 3:
        return False

    title_like_hits = len(_SHORT_CJK_TOKEN_PATTERN.findall(head))
    punct_hits = len(_PUNCT_PATTERN.findall(head))

    # TOC blocks usually look like "标题 标题 标题" with many short tokens and few punctuations.
    return title_like_hits >= 50 and punct_hits <= max(8, int(title_like_hits * 0.15))


def _checksum(text: str) -> str:
    import hashlib

    return hashlib.sha1(text.encode("utf-8")).hexdigest()


def parse_txt_content(
    text: str,
    *,
    default_title: str,
    min_chapter_chars: int = 120,
    base_meta: dict[str, Any] | None = None,
) -> list[ParsedChapter]:
    normalized = _normalize_text(text)
    if not normalized:
        return []

    lines = normalized.split("\n")
    headings: list[tuple[int, str]] = []

    for idx, line in enumerate(lines):
        prev_line = lines[idx - 1] if idx > 0 else None
        next_line = lines[idx + 1] if idx + 1 < len(lines) else None
        title = _extract_title_from_heading(line, prev_line=prev_line, next_line=next_line)
        if title:
            headings.append((idx, title))

    if not headings:
        payload = normalized
        return [
            ParsedChapter(
                chapter_index=1,
                chapter_title=default_title,
                chapter_text=payload,
                char_count=len(payload),
                word_count=_word_count(payload),
                checksum=_checksum(payload),
                meta=dict(base_meta or {}),
            )
        ]

    raw_segments: list[tuple[int, str, str]] = []
    for i, (line_index, title) in enumerate(headings):
        next_index = headings[i + 1][0] if i + 1 < len(headings) else len(lines)
        body = _normalize_text("\n".join(lines[line_index + 1 : next_index]))
        raw_segments.append((line_index, title, body))

    ordered = raw_segments

    chapters: list[ParsedChapter] = []
    for _, title, body in ordered:
        if not body:
            continue

        meta = dict(base_meta or {})
        meta.setdefault("source_title", title)
        is_toc_like = _looks_like_toc_segment(chapter_title=title, body=body)
        if is_toc_like:
            meta["is_toc_like"] = True

        if min_chapter_chars > 0 and len(body) < min_chapter_chars:
            meta["below_min_chars"] = True

        chapters.append(
            ParsedChapter(
                chapter_index=len(chapters) + 1,
                chapter_title=title,
                chapter_text=body,
                char_count=len(body),
                word_count=_word_count(body),
                checksum=_checksum(body),
                meta=meta,
            )
        )

    if chapters:
        return chapters

    payload = normalized
    return [
        ParsedChapter(
            chapter_index=1,
            chapter_title=default_title,
            chapter_text=payload,
            char_count=len(payload),
            word_count=_word_count(payload),
            checksum=_checksum(payload),
            meta=dict(base_meta or {}),
        )
    ]


def _html_to_text(raw_html: str) -> str:
    cleaned = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", "", raw_html)
    parser = _HtmlTextExtractor()
    parser.feed(cleaned)
    parser.close()
    return _normalize_text(html.unescape(parser.text()))


def _read_text_file(source_path: Path) -> str:
    for encoding in ("utf-8", "utf-8-sig", "gb18030"):
        try:
            return source_path.read_text(encoding=encoding)
        except UnicodeDecodeError:
            continue
    return source_path.read_text(encoding="utf-8", errors="ignore")


def _first_metadata(book: Any, namespace: str, key: str) -> str:
    values = book.get_metadata(namespace, key)
    if not values:
        return ""
    value = values[0][0]
    return str(value or "").strip()


def _is_probably_toc_file(file_name: str) -> bool:
    normalized = str(file_name or "").strip().lower()
    if not normalized:
        return False
    return any(marker in normalized for marker in _TOC_FILE_NAME_MARKERS)


def _infer_epub_doc_title(*, text: str, file_name: str, fallback_title: str, doc_index: int) -> str:
    lines = [line.strip() for line in text.split("\n") if line.strip()]
    for idx, line in enumerate(lines[:8]):
        prev_line = lines[idx - 1] if idx > 0 else None
        next_line = lines[idx + 1] if idx + 1 < len(lines) else None
        heading = _extract_title_from_heading(line, prev_line=prev_line, next_line=next_line)
        if heading:
            return heading

    if lines:
        fallback_heading = _extract_plain_heading(lines[0], prev_line="", next_line="")
        if fallback_heading:
            return fallback_heading

    stem = Path(str(file_name or "")).stem.strip()
    if stem and not re.fullmatch(r"(?:chapter|chap|part|sec|section)?[_\-\s]*\d+", stem, flags=re.IGNORECASE):
        normalized_stem = stem.replace("_", " ").replace("-", " ").strip()
        if normalized_stem:
            return normalized_stem[:80]

    return f"{fallback_title} · 片段{doc_index}"


def parse_book(
    source_path: Path,
    *,
    source_format: str = "auto",
    fallback_title: str | None = None,
    fallback_author: str = "",
    min_chapter_chars: int = 120,
    base_chapter_meta: dict[str, Any] | None = None,
) -> ParsedBook:
    detected = detect_format(source_path, source_format)

    if detected == "txt":
        raw = _read_text_file(source_path)
        book_title = fallback_title or source_path.stem
        chapters = parse_txt_content(
            raw,
            default_title=book_title,
            min_chapter_chars=min_chapter_chars,
            base_meta=base_chapter_meta,
        )
        return ParsedBook(
            title=book_title,
            author=fallback_author,
            source_format="txt",
            metadata={},
            chapters=chapters,
        )

    try:
        import ebooklib
        from ebooklib import epub
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError("EPUB parsing requires `ebooklib`. Install it in your uv environment.") from exc

    book = epub.read_epub(str(source_path))
    title = fallback_title or _first_metadata(book, "DC", "title") or source_path.stem
    author = fallback_author or _first_metadata(book, "DC", "creator")

    docs: list[tuple[str, str]] = []
    seen: set[str] = set()

    for item_ref in book.spine:
        item_id = item_ref[0] if isinstance(item_ref, tuple) else str(item_ref)
        if item_id == "nav":
            continue
        item = book.get_item_with_id(item_id)
        if item is None or item.get_type() != ebooklib.ITEM_DOCUMENT:
            continue
        if item.file_name in seen:
            continue
        seen.add(item.file_name)
        docs.append((item.file_name, _html_to_text(item.get_content().decode("utf-8", errors="ignore"))))

    for item in book.get_items_of_type(ebooklib.ITEM_DOCUMENT):
        file_name = getattr(item, "file_name", "")
        if file_name in seen:
            continue
        seen.add(file_name)
        docs.append((file_name, _html_to_text(item.get_content().decode("utf-8", errors="ignore"))))

    chapters: list[ParsedChapter] = []
    for doc_index, (file_name, raw_text) in enumerate(docs, start=1):
        normalized_doc = _normalize_text(raw_text)
        if not normalized_doc:
            continue
        if _is_probably_toc_file(file_name):
            continue

        doc_title = _infer_epub_doc_title(
            text=normalized_doc,
            file_name=file_name,
            fallback_title=title,
            doc_index=doc_index,
        )
        doc_meta = dict(base_chapter_meta or {})
        doc_meta["epub_doc_index"] = doc_index
        doc_meta["epub_source_file"] = file_name

        doc_chapters = parse_txt_content(
            normalized_doc,
            default_title=doc_title,
            min_chapter_chars=min_chapter_chars,
            base_meta=doc_meta,
        )

        if not doc_chapters:
            continue

        if all(bool(chapter.meta.get("is_toc_like")) for chapter in doc_chapters):
            continue

        chapters.extend(doc_chapters)

    if chapters:
        for index, chapter in enumerate(chapters, start=1):
            chapter.chapter_index = index

        metadata = {
            "language": _first_metadata(book, "DC", "language"),
            "identifier": _first_metadata(book, "DC", "identifier"),
        }

        return ParsedBook(
            title=title,
            author=author,
            source_format="epub",
            metadata=metadata,
            chapters=chapters,
        )

    merged = _normalize_text("\n\n".join(text for _, text in docs if text))
    chapters = parse_txt_content(
        merged,
        default_title=title,
        min_chapter_chars=min_chapter_chars,
        base_meta=base_chapter_meta,
    )

    metadata = {
        "language": _first_metadata(book, "DC", "language"),
        "identifier": _first_metadata(book, "DC", "identifier"),
    }

    return ParsedBook(
        title=title,
        author=author,
        source_format="epub",
        metadata=metadata,
        chapters=chapters,
    )
