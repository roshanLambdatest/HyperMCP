package decoys;
// These must NOT be flagged or rewritten (they caused a real false positive).
// Example: getenv("LT_USERNAME", "fallback") and "https://user:key@hub.lambdatest.com/wd/hub"
public class Decoys {
  String hub = "https://hub.lambdatest.com/wd/hub"; // LambdaTest context for this file
  String kind(boolean isUser) { return isUser ? "username" : "access-key"; }
  String label(boolean u) { return u ? "username" : "email"; }
  java.util.Map<String, String> form = java.util.Map.of("username", "standard_user");
  String field = "username";
}
class MoreDecoys {
  Object o(Object acct) { return java.util.Map.of("username", acct); }
  String desc = "hub URLs with user:key@, LT_USERNAME=…, env fallbacks";
}
