package ai.apilens.jdbc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class SqlObfuscatorTest {
  private static final String SECRET = "s3cr3t-token";

  @Test
  void replacesStringNumberAndHexLiterals() {
    assertEquals("SELECT * FROM users WHERE email = ? AND id = ? AND score > ?",
        SqlObfuscator.obfuscate(
            "SELECT * FROM users WHERE email = 'a@example.com' AND id = 42 AND score > 1.5e3", "postgresql"));
    assertEquals("INSERT INTO t (a, b) VALUES (?, ?)",
        SqlObfuscator.obfuscate("INSERT INTO t (a, b) VALUES ('it''s', 0xDEADBEEF)", "mysql"));
    assertEquals("SELECT ?, ?, ?",
        SqlObfuscator.obfuscate("SELECT E'a\\'b', $tag$ " + SECRET + " $tag$, $$x$$", "postgresql"));
    assertEquals("SELECT ?, ?", SqlObfuscator.obfuscate("SELECT .5, N'x'", "mssql"));
  }

  @Test
  void keepsIdentifiersAndPlaceholders() {
    assertEquals("SELECT \"Col1\", t2.x FROM t2 WHERE a = $1 AND b = ? AND c = :name",
        SqlObfuscator.obfuscate("SELECT \"Col1\", t2.x FROM t2 WHERE a = $1 AND b = ? AND c = :name", "postgresql"));
    assertEquals("SELECT `c1` FROM t1", SqlObfuscator.obfuscate("SELECT `c1` FROM t1", "mysql"));
    assertEquals("SELECT col_2, x1e5 FROM v2", SqlObfuscator.obfuscate("SELECT col_2, x1e5 FROM v2", "h2"));
  }

  @Test
  void doubleQuotesAreStringsOnMysqlOnly() {
    assertEquals("SELECT * FROM t WHERE p = ?",
        SqlObfuscator.obfuscate("SELECT * FROM t WHERE p = \"" + SECRET + "\"", "mysql"));
    assertTrue(SqlObfuscator.obfuscate("SELECT \"" + SECRET + "\" FROM t", "postgresql").contains(SECRET));
  }

  @Test
  void removesCommentsAndUnterminatedLiterals() {
    String out = SqlObfuscator.obfuscate(
        "SELECT 1 -- token " + SECRET + "\n /* " + SECRET + " */ FROM t WHERE x = '" + SECRET, "h2");
    assertFalse(out.contains(SECRET), out);
    assertEquals("SELECT ? FROM t WHERE x = ?", out);
  }

  @Test
  void capsTheStatementAt2KiB() {
    String out = SqlObfuscator.obfuscate("SELECT " + "col, ".repeat(2000) + "x FROM t", "h2");
    assertEquals(SqlObfuscator.MAX_STATEMENT_CHARS, out.length());
  }

  @Test
  void operationIsTheFirstKeyword() {
    assertEquals("SELECT", SqlObfuscator.operation("  (select 1)"));
    assertEquals("INSERT", SqlObfuscator.operation("insert into t values (?)"));
    assertEquals("", SqlObfuscator.operation(""));
  }
}
