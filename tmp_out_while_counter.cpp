#include <iostream>

using namespace std;

int main() {
    // Warning: data dependency cycle detected, emitting in source order
    // node:var_decl
    int var_counter = 0;
    // node:lit_one
    int v_lit_one = 1;
    // node:lit_limit
    int v_lit_limit = 3;
    // node:var_get_cond
    auto v_var_get_cond = var_counter;
    // node:less
    bool v_less = v_var_get_cond < v_lit_limit;
    // node:while1
    // Unhandled node type in graph: While (id=while1)
    // node:var_get_body
    auto v_var_get_body = var_counter;
    {
      int __loop_guard = 0;
      while ((v_less) && (++__loop_guard < 100000)) {
    // node:add
    double v_add = v_var_get_body + v_lit_one;
    // node:p_print
    std::cout << v_var_get_body << std::endl;
    // node:var_set
    var_counter = v_add;
      }
    }
    return 0;
}
