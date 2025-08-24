#include <iostream>

double addOne(double x) {
    double v_literal1 = 1;
    double v_n_add = x + v_literal1;
    return v_n_add;
}

int main() {
    double v_n1 = 10;
    double v_n2 = addOne(v_n1);
    std::cout << v_n2 << std::endl;
    return 0;
}