package ai.apilens.resources;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AccessDeniedException;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

/**
 * Reads the small text files of procfs and cgroupfs under an injectable root, so tests point it
 * at a fake tree ({@code testdata/cgroup/<case>/root}). Every read is bounded and never throws
 * for a missing or unreadable file: it returns {@code null} and the value stays unmeasured.
 */
public final class Fs {
  private static final int MAX_FILE_BYTES = 256 * 1024;
  private final Path root;
  private final Consumer<Path> onRead;

  Fs(Path root, Consumer<Path> onRead) {
    this.root = root;
    this.onRead = onRead;
  }

  /** The real filesystem. */
  public static Fs system() {
    return new Fs(Path.of("/"), null);
  }

  /** A fake tree rooted at {@code root}. */
  public static Fs at(Path root) {
    return new Fs(root, null);
  }

  /** A fake tree that reports every path it reads (privacy tests). */
  static Fs at(Path root, Consumer<Path> onRead) {
    return new Fs(root, onRead);
  }

  /** {@code absolute} ("/proc/self/cgroup") under the root. */
  Path path(String absolute) {
    String relative = absolute.startsWith("/") ? absolute.substring(1) : absolute;
    return relative.isEmpty() ? root : root.resolve(relative);
  }

  /** The file's text, or {@code null} when it is missing or unreadable. */
  String read(Path file) {
    try {
      return readOrThrow(file);
    } catch (IOException | RuntimeException ex) {
      return null;
    }
  }

  String read(String absolute) {
    return read(path(absolute));
  }

  /** Like {@link #read(Path)}, but a permission error surfaces as {@link AccessDeniedException}. */
  String readOrThrow(Path file) throws IOException {
    if (onRead != null) {
      onRead.accept(file);
    }
    try (var in = Files.newInputStream(file)) {
      byte[] raw = in.readNBytes(MAX_FILE_BYTES);
      return new String(raw, StandardCharsets.UTF_8);
    }
  }

  /** The first line, trimmed; {@code null} when missing or empty. */
  String firstLine(Path file) {
    String text = read(file);
    if (text == null) {
      return null;
    }
    int nl = text.indexOf('\n');
    String line = (nl < 0 ? text : text.substring(0, nl)).trim();
    return line.isEmpty() ? null : line;
  }

  /** The file's single number; {@code null} when missing or not a number. */
  Double number(Path file) {
    return parse(firstLine(file));
  }

  /** "key value" lines (cpu.stat, memory.stat, memory.events) as numbers. */
  Map<String, Double> keyValues(Path file) {
    String text = read(file);
    Map<String, Double> out = new LinkedHashMap<>();
    if (text == null) {
      return null;
    }
    for (String line : text.split("\n")) {
      String[] parts = line.trim().split("\\s+");
      if (parts.length >= 2) {
        Double value = parse(parts[1]);
        if (value != null) {
          out.put(parts[0], value);
        }
      }
    }
    return out;
  }

  /** "Key:\tvalue [kB]" lines (/proc/self/status, smaps_rollup); kB values become bytes. */
  static Map<String, Double> colonValues(String text) {
    Map<String, Double> out = new LinkedHashMap<>();
    if (text == null) {
      return out;
    }
    for (String line : text.split("\n")) {
      int colon = line.indexOf(':');
      if (colon <= 0) {
        continue;
      }
      String[] parts = line.substring(colon + 1).trim().split("\\s+");
      if (parts.length == 0) {
        continue;
      }
      Double value = parse(parts[0]);
      if (value == null) {
        continue;
      }
      if (parts.length > 1 && parts[1].equalsIgnoreCase("kB")) {
        value = value * 1024;
      }
      out.put(line.substring(0, colon).trim(), value);
    }
    return out;
  }

  /** The non-empty lines of a file; an empty list when missing. */
  List<String> lines(String absolute) {
    String text = read(absolute);
    List<String> out = new ArrayList<>();
    if (text == null) {
      return out;
    }
    for (String line : text.split("\n")) {
      if (!line.isBlank()) {
        out.add(line);
      }
    }
    return out;
  }

  /** Names of the entries of a directory; empty when missing. */
  List<String> list(String absolute) {
    List<String> out = new ArrayList<>();
    try (DirectoryStream<Path> entries = Files.newDirectoryStream(path(absolute))) {
      for (Path entry : entries) {
        out.add(entry.getFileName().toString());
      }
    } catch (IOException | RuntimeException ex) {
      // Missing or unreadable: nothing to list.
    }
    return out;
  }

  boolean isDirectory(Path dir) {
    return Files.isDirectory(dir);
  }

  static Double parse(String raw) {
    if (raw == null || raw.isEmpty()) {
      return null;
    }
    try {
      double value = Double.parseDouble(raw.trim());
      return Double.isFinite(value) ? value : null;
    } catch (NumberFormatException ex) {
      return null;
    }
  }
}
