#include <iostream>

int addTwo() {
  auto add_1 = (a) + (b);
  return add_1;
}

int main() {
  auto const_1 = 5;
  auto const_2 = 7;
  auto call_3 = addTwo(const_1, const_2);
  std::cout << call_3 << std::endl;
  return 0;
}
