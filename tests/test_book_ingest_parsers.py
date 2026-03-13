from __future__ import annotations

import unittest

from scripts.book_ingest.parsers import parse_txt_content


class BookIngestParserTests(unittest.TestCase):
    def test_parse_txt_content_keeps_toc_like_segment_but_marks_it(self) -> None:
        text = """
【人妖】
附录
概览
【卷·一】
考城隍 耳中人 尸变 喷水 瞳人语 画壁 山魈 咬鬼 捉狐 荍中怪 宅妖 王六郎 偷桃 种梨
【卷·二】
金世成 董生 龁石 庙鬼 陆判 婴宁 聂小倩 义鼠 地震 海公子 丁前溪

【考城隍】
我姐夫的祖父，名叫宋焘，是本县的廪生。有一天，他生病卧床，见一个小官吏拿帖子来找他。
"""
        chapters = parse_txt_content(text, default_title="聊斋", min_chapter_chars=20)
        self.assertEqual([chapter.chapter_title for chapter in chapters], ["人妖", "考城隍"])
        self.assertTrue(chapters[0].meta.get("is_toc_like"))
        self.assertFalse(bool(chapters[1].meta.get("is_toc_like")))

    def test_parse_txt_content_keeps_duplicate_titles_in_order(self) -> None:
        text = """
目录
【画皮】
【聂小倩】

卷·一
【画皮】
这是画皮正文第一段。
这是画皮正文第二段，内容明显更长。

        【聂小倩】
        这是聂小倩正文，应该被保留。
"""
        chapters = parse_txt_content(text, default_title="聊斋", min_chapter_chars=10)
        titles = [chapter.chapter_title for chapter in chapters]
        self.assertGreaterEqual(titles.count("聂小倩"), 2)
        self.assertIn("画皮", titles)
        self.assertTrue(any("画皮正文" in chapter.chapter_text for chapter in chapters if chapter.chapter_title == "画皮"))

    def test_parse_txt_content_falls_back_to_single_story_without_headings(self) -> None:
        text = "这是一个没有章节标题的短篇故事。"
        chapters = parse_txt_content(text, default_title="短篇", min_chapter_chars=5)
        self.assertEqual(len(chapters), 1)
        self.assertEqual(chapters[0].chapter_title, "短篇")
        self.assertEqual(chapters[0].chapter_text, text)

    def test_parse_txt_content_detects_plain_title_headings_with_blank_lines(self) -> None:
        text = """
序言说明。

狗·猫·鼠

这是第一篇正文，应该被识别为章节内容。

阿长与山海经

这是第二篇正文，也应该被识别。
"""
        chapters = parse_txt_content(text, default_title="朝花夕拾", min_chapter_chars=5)
        self.assertEqual([chapter.chapter_title for chapter in chapters], ["狗·猫·鼠", "阿长与山海经"])

    def test_parse_txt_content_plain_titles_require_blank_context(self) -> None:
        text = "狗·猫·鼠\n这是正文第一段。\n阿长与山海经\n这是正文第二段。"
        chapters = parse_txt_content(text, default_title="朝花夕拾", min_chapter_chars=5)
        self.assertEqual(len(chapters), 1)
        self.assertEqual(chapters[0].chapter_title, "朝花夕拾")


if __name__ == "__main__":
    unittest.main()
