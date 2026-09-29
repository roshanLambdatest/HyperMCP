import os, pytest
KEY = os.environ.get("LT_ACCESS_KEY")

@pytest.mark.smoke
def test_login():
    pass

class TestCheckout:
    def test_pay(self):
        pass
