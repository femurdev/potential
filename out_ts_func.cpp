#include <iostream>

int __g2c_addTwo(int __g2c_a, int __g2c_b);

int __g2c_addTwo(int __g2c_a, int __g2c_b) {
  // node:arg_a
  // node:arg_b
  // node:add
  auto add_1 = (__g2c_a) + (__g2c_b);
  // node:ret
  return add_1;
}

int main() {
  // node:c1
  auto const_1 = 5;
  // node:c2
  auto const_2 = 7;
  // node:call1
  auto call_3 = __g2c_addTwo(const_1, const_2);
  // node:print1
  std::cout << call_3 << std::endl;
  return 0;
}