// Deliberately tiny, strict JSON for ONE flat object per line: string / integer / true / false / null values only.
// No nesting, no duplicate keys, ASCII strings, bounded size. Anything else is a parse failure (never an exception).
#pragma once
#include <string>
#include <vector>

namespace trivo {

struct JsonValue {
  enum Type { Str, Int, Other } type = Other;
  std::string s;
  long long i = 0;
};
struct JsonObject {
  std::vector<std::pair<std::string, JsonValue>> members;
  const JsonValue* find(const std::string& k) const;
};

constexpr size_t kMaxLine = 64 * 1024;

bool parseFlatObject(const std::string& line, JsonObject& out);
std::string jsonString(const std::string& ascii);  // quoted + escaped

}  // namespace trivo
