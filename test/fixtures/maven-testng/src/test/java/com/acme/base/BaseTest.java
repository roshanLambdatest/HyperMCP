package com.acme.base;
public abstract class BaseTest {
  protected String hub = "https://" + System.getenv("LT_USERNAME") + ":" + System.getenv("LT_ACCESS_KEY") + "@hub.lambdatest.com/wd/hub";
  protected String base = System.getenv("BASE_URL");
}
