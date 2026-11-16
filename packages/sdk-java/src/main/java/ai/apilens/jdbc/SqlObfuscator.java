package ai.apilens.jdbc;

import java.util.Locale;

/**
 * Removes every literal from a SQL statement before it leaves the process, with the same rules as
 * the Python and TypeScript SDKs: strings ({@code '…'}, {@code E'…'}, {@code $tag$…$tag$}, and
 * {@code "…"} on MySQL, where it is a string), numbers and hex literals become {@code ?};
 * comments are removed, whitespace is collapsed and the result is cut to {@link
 * #MAX_STATEMENT_CHARS}. Identifiers ({@code "col"} on PostgreSQL and standard SQL, {@code
 * `col`}) and placeholders ({@code ?}, {@code $1}, {@code :name}) are kept. Bound parameter
 * values are never read.
 */
public final class SqlObfuscator {
  /** Longest {@code db.statement} sent, after obfuscation (2 KiB). */
  public static final int MAX_STATEMENT_CHARS = 2048;

  private SqlObfuscator() {}

  /** {@code sql} with every literal replaced by {@code ?}; {@code system} is the {@code db.system}. */
  public static String obfuscate(String sql, String system) {
    if (sql == null || sql.isEmpty()) {
      return "";
    }
    boolean mysql = "mysql".equals(system) || "mariadb".equals(system);
    StringBuilder out = new StringBuilder(Math.min(sql.length(), MAX_STATEMENT_CHARS * 2) + 16);
    int n = sql.length();
    int i = 0;
    // Stop once well past the cap: collapsing whitespace only shortens what is left.
    while (i < n && out.length() <= MAX_STATEMENT_CHARS * 4) {
      char c = sql.charAt(i);
      char prev = i > 0 ? sql.charAt(i - 1) : ' ';
      char next = i + 1 < n ? sql.charAt(i + 1) : '\0';
      if (c == '-' && next == '-') {
        int end = sql.indexOf('\n', i);
        i = end < 0 ? n : end;
        out.append(' ');
      } else if (c == '/' && next == '*') {
        int end = sql.indexOf("*/", i + 2);
        i = end < 0 ? n : end + 2;
        out.append(' ');
      } else if (c == '\'') {
        i = skipQuoted(sql, i, '\'');
        out.append('?');
      } else if (isStringPrefix(c) && next == '\'' && !isWord(prev)) {
        i = skipQuoted(sql, i + 1, '\'');
        out.append('?');
      } else if (c == '"') {
        int end = skipQuoted(sql, i, '"');
        if (mysql || end == n && sql.charAt(n - 1) != '"') {
          // A string on MySQL; an unterminated quote may hide a literal, so it goes too.
          out.append('?');
        } else {
          out.append(sql, i, end);
        }
        i = end;
      } else if (c == '`') {
        int end = sql.indexOf('`', i + 1);
        end = end < 0 ? n : end + 1;
        out.append(sql, i, end);
        i = end;
      } else if (c == '$' && dollarTagEnd(sql, i) > 0) {
        int tagEnd = dollarTagEnd(sql, i);
        String tag = sql.substring(i, tagEnd);
        int close = sql.indexOf(tag, tagEnd);
        i = close < 0 ? n : close + tag.length();
        out.append('?');
      } else if (c == '0' && (next == 'x' || next == 'X') && i + 2 < n && isHex(sql.charAt(i + 2))
          && !isWord(prev) && prev != '.') {
        int end = i + 2;
        while (end < n && isHex(sql.charAt(end))) {
          end++;
        }
        i = literalOrWord(sql, i, end, out);
      } else if ((isDigit(c) || (c == '.' && isDigit(next))) && !isWord(prev) && prev != '.') {
        i = literalOrWord(sql, i, numberEnd(sql, i), out);
      } else if (isWord(c)) {
        int end = wordEnd(sql, i);
        out.append(sql, i, end);
        i = end;
      } else {
        out.append(c);
        i++;
      }
    }
    String collapsed = out.toString().replaceAll("\\s+", " ").trim();
    return collapsed.length() > MAX_STATEMENT_CHARS ? collapsed.substring(0, MAX_STATEMENT_CHARS) : collapsed;
  }

  /** The statement's first keyword, upper-cased ({@code SELECT}, {@code INSERT}, …), or "". */
  public static String operation(String sql) {
    if (sql == null) {
      return "";
    }
    int i = 0;
    int n = sql.length();
    while (i < n && (Character.isWhitespace(sql.charAt(i)) || sql.charAt(i) == '(')) {
      i++;
    }
    int start = i;
    while (i < n && isLetter(sql.charAt(i))) {
      i++;
    }
    return sql.substring(start, i).toUpperCase(Locale.ROOT);
  }

  /** {@code ?} for the literal {@code [start, end)}, or the whole word when one runs on from it. */
  private static int literalOrWord(String sql, int start, int end, StringBuilder out) {
    if (end < sql.length() && isWord(sql.charAt(end))) {
      int wordEnd = wordEnd(sql, end);
      out.append(sql, start, wordEnd);
      return wordEnd;
    }
    out.append('?');
    return end;
  }

  /** Index just past the closing quote of the string opening at {@code start}, or the end. */
  private static int skipQuoted(String sql, int start, char quote) {
    int n = sql.length();
    int i = start + 1;
    while (i < n) {
      char c = sql.charAt(i);
      if (c == '\\') {
        i += 2;
      } else if (c == quote) {
        if (i + 1 < n && sql.charAt(i + 1) == quote) {
          i += 2;
        } else {
          return i + 1;
        }
      } else {
        i++;
      }
    }
    return n;
  }

  /** End of a {@code $tag$} opener at {@code start} ({@code $$} included), or -1. */
  private static int dollarTagEnd(String sql, int start) {
    if (start > 0 && isWord(sql.charAt(start - 1))) {
      return -1;
    }
    int n = sql.length();
    int i = start + 1;
    if (i < n && (isLetter(sql.charAt(i)) || sql.charAt(i) == '_')) {
      while (i < n && (isLetter(sql.charAt(i)) || isDigit(sql.charAt(i)) || sql.charAt(i) == '_')) {
        i++;
      }
    }
    return i < n && sql.charAt(i) == '$' ? i + 1 : -1;
  }

  private static int numberEnd(String sql, int start) {
    int n = sql.length();
    int i = start;
    while (i < n && isDigit(sql.charAt(i))) {
      i++;
    }
    if (i < n && sql.charAt(i) == '.') {
      i++;
      while (i < n && isDigit(sql.charAt(i))) {
        i++;
      }
    }
    if (i < n && (sql.charAt(i) == 'e' || sql.charAt(i) == 'E')) {
      int j = i + 1;
      if (j < n && (sql.charAt(j) == '+' || sql.charAt(j) == '-')) {
        j++;
      }
      if (j < n && isDigit(sql.charAt(j))) {
        while (j < n && isDigit(sql.charAt(j))) {
          j++;
        }
        i = j;
      }
    }
    return i;
  }

  private static int wordEnd(String sql, int start) {
    int i = start;
    while (i < sql.length() && isWord(sql.charAt(i))) {
      i++;
    }
    return i;
  }

  private static boolean isStringPrefix(char c) {
    return "EeNnXxBb".indexOf(c) >= 0;
  }

  private static boolean isWord(char c) {
    return isLetter(c) || isDigit(c) || c == '_' || c == '$';
  }

  private static boolean isLetter(char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
  }

  private static boolean isDigit(char c) {
    return c >= '0' && c <= '9';
  }

  private static boolean isHex(char c) {
    return isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
  }
}
