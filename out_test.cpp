#include <iostream>

using namespace std;

int main() {
    // Warning: Data dependency cycle detected involving nodes: 
    int var_counter = 0;
    // Unhandled node type in graph: Literal (id=lit_one)
    // Unhandled node type in graph: Literal (id=lit_limit)
    auto v_var_get_cond = var_counter;
    // Unhandled node type in graph: LessThan (id=less)
    auto v_var_get_body = var_counter;
    while (v_less) {
    std::cout << v_var_get_body << std::endl;
    double v_add = v_var_get_body + v_lit_one;
    var_counter = v_add;
    }
    return 0;
}

