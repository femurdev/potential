#include <iostream>

int main() {
  auto const_1 = 1;
  auto const_2 = 2;
  auto add_3 = (const_1) + (const_2);
  std::cout << add_3 << std::endl;
  return 0;
}
