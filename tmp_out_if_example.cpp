#include <iostream>

using namespace std;

int main() {
    // node:lit_cond
    bool v_lit_cond = true;
    // node:if1
    // Unhandled node type in graph: If (id=if1)
    if (v_lit_cond) {
    // node:p_then
    std::cout << "Then branch" << std::endl;
    }
    return 0;
}
