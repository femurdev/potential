#include <iostream>

using namespace std;

int getAnswer() {
    double getAnswer_v_f_lit = 42;
    return getAnswer_v_f_lit;
}

int main() {
    double v_lit1 = 42;
    int v_call1 = getAnswer();
    std::cout << v_call1 << std::endl;
    return 0;
}

