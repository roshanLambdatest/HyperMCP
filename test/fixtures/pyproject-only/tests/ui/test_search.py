import os
import pytest


@pytest.mark.smoke
def test_search_box():
    assert os.environ.get("APP_URL")


def test_search_results():
    pass
