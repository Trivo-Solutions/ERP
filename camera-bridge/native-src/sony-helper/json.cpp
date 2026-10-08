#include "json.h"

namespace trivo {

const JsonValue* JsonObject::find(const std::string& k) const {
  for (const auto& m : members) if (m.first == k) return &m.second;
  return nullptr;
}

namespace {
struct P {
  const std::string& t;
  size_t p = 0;
  explicit P(const std::string& s) : t(s) {}
  void ws() { while (p < t.size() && (t[p] == ' ' || t[p] == '\t' || t[p] == '\r')) ++p; }
  bool lit(const char* w) {
    size_t n = 0;
    while (w[n]) ++n;
    if (t.compare(p, n, w) != 0) return false;
    p += n;
    return true;
  }
  bool str(std::string& out) {
    if (p >= t.size() || t[p] != '"') return false;
    ++p;
    out.clear();
    while (p < t.size()) {
      unsigned char c = (unsigned char)t[p++];
      if (c == '"') return true;
      if (c < 0x20 || c >= 0x80) return false;  // control chars and non-ASCII are not valid here
      if (c != '\\') { out += (char)c; continue; }
      if (p >= t.size()) return false;
      char e = t[p++];
      switch (e) {
        case '"': case '\\': case '/': out += e; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'u': {
          if (p + 4 > t.size()) return false;
          unsigned v = 0;
          for (int k = 0; k < 4; ++k) {
            char h = t[p++];
            v <<= 4;
            if (h >= '0' && h <= '9') v |= h - '0';
            else if (h >= 'a' && h <= 'f') v |= h - 'a' + 10;
            else if (h >= 'A' && h <= 'F') v |= h - 'A' + 10;
            else return false;
          }
          if (v == 0 || v >= 0x80) return false;  // ASCII only (and no NUL)
          out += (char)v;
          break;
        }
        default: return false;
      }
    }
    return false;  // unterminated
  }
  bool num(long long& v) {
    bool neg = false;
    if (p < t.size() && t[p] == '-') { neg = true; ++p; }
    size_t d = p;
    v = 0;
    while (p < t.size() && t[p] >= '0' && t[p] <= '9') {
      v = v * 10 + (t[p] - '0');
      ++p;
      if (p - d > 10) return false;
    }
    if (p == d) return false;
    if (t[d] == '0' && p - d > 1) return false;  // no leading zeros
    if (p < t.size() && (t[p] == '.' || t[p] == 'e' || t[p] == 'E')) return false;  // integers only
    if (neg) v = -v;
    return true;
  }
};
}  // namespace

bool parseFlatObject(const std::string& line, JsonObject& out) {
  out.members.clear();
  if (line.size() > kMaxLine) return false;
  P q(line);
  q.ws();
  if (q.p >= line.size() || line[q.p] != '{') return false;
  ++q.p;
  q.ws();
  if (q.p < line.size() && line[q.p] == '}') { ++q.p; q.ws(); return q.p == line.size(); }
  for (;;) {
    q.ws();
    std::string key;
    if (!q.str(key)) return false;
    for (const auto& m : out.members) if (m.first == key) return false;  // duplicate key
    q.ws();
    if (q.p >= line.size() || line[q.p] != ':') return false;
    ++q.p;
    q.ws();
    JsonValue v;
    if (q.p >= line.size()) return false;
    char c = line[q.p];
    if (c == '"') { v.type = JsonValue::Str; if (!q.str(v.s)) return false; }
    else if (c == '-' || (c >= '0' && c <= '9')) { v.type = JsonValue::Int; if (!q.num(v.i)) return false; }
    else if (q.lit("true") || q.lit("false") || q.lit("null")) { v.type = JsonValue::Other; }
    else return false;  // objects / arrays / anything else
    out.members.emplace_back(std::move(key), std::move(v));
    if (out.members.size() > 8) return false;
    q.ws();
    if (q.p >= line.size()) return false;
    if (line[q.p] == ',') { ++q.p; continue; }
    if (line[q.p] == '}') { ++q.p; q.ws(); return q.p == line.size(); }
    return false;
  }
}

std::string jsonString(const std::string& s) {
  std::string o = "\"";
  for (unsigned char c : s) {
    if (c == '"' || c == '\\') { o += '\\'; o += (char)c; }
    else if (c < 0x20 || c >= 0x7f) { o += '?'; }  // callers pass validated ASCII; this is belt-and-braces
    else o += (char)c;
  }
  return o + "\"";
}

}  // namespace trivo
